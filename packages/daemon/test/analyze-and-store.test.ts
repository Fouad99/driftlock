import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RepoStore, openRepoDb } from '@driftlock/core';
import { analyzeAndStore } from '../src/analyze-and-store.ts';

let dir: string;
let repoDb: RepoStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driftlock-analyze-store-test-'));
  repoDb = openRepoDb(join(dir, 'repo.sqlite'));
});

afterEach(() => {
  repoDb.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedLoopingSession(): string {
  const session = repoDb.createSession({
    agent: 'codex',
    agentSession: null,
    repoRoot: '/repo',
    branch: null,
    headBefore: null,
    headAfter: null,
    startedAt: 1000,
    taskText: null,
    tokenIn: null,
    tokenOut: null,
    costUsd: null,
    source: 'transcript',
  });
  // 3 edit/test cycles on the same path — trips the `loop` analyzer.
  repoDb.appendEvents(session.id, [
    { sessionId: session.id, ts: 1, kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
    {
      sessionId: session.id,
      ts: 2,
      kind: 'test_run',
      payload: { command: 'npm test', exitCode: 1 },
    },
    { sessionId: session.id, ts: 3, kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
    {
      sessionId: session.id,
      ts: 4,
      kind: 'test_run',
      payload: { command: 'npm test', exitCode: 1 },
    },
    { sessionId: session.id, ts: 5, kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
    {
      sessionId: session.id,
      ts: 6,
      kind: 'test_run',
      payload: { command: 'npm test', exitCode: 1 },
    },
    { sessionId: session.id, ts: 7, kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
  ]);
  return session.id;
}

describe('analyzeAndStore', () => {
  test('running it twice on the same session does not duplicate findings', async () => {
    const sessionId = seedLoopingSession();

    const first = await analyzeAndStore(sessionId, '/repo', repoDb);
    expect(first).toBeGreaterThan(0);
    const afterFirst = repoDb.listFindings({ sessionId, open: true });

    const second = await analyzeAndStore(sessionId, '/repo', repoDb);
    const afterSecond = repoDb.listFindings({ sessionId, open: true });

    expect(second).toBe(first);
    expect(afterSecond).toHaveLength(afterFirst.length); // not doubled
  });

  test('preserves a user-resolved finding across re-analysis instead of reviving or duplicating it', async () => {
    const sessionId = seedLoopingSession();
    await analyzeAndStore(sessionId, '/repo', repoDb);

    const [toResolve] = repoDb.listFindings({ sessionId, open: true });
    repoDb.resolveFinding(toResolve?.id as string, 9999);

    await analyzeAndStore(sessionId, '/repo', repoDb);

    const resolved = repoDb.getFinding(toResolve?.id as string);
    expect(resolved?.resolvedAt).toBe(9999); // still resolved, not wiped or duplicated
    const openNow = repoDb.listFindings({ sessionId, open: true });
    expect(openNow.some((f) => f.id === toResolve?.id)).toBe(false);
  });
});
