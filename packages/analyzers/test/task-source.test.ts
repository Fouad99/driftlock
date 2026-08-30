import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoStore, SessionInit } from '@driftlock/core';
import { openRepoDb } from '@driftlock/core';
import { TranscriptTaskSource } from '../src/task-source.ts';

let dir: string;
let repoDb: RepoStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driftlock-task-source-test-'));
  repoDb = openRepoDb(join(dir, 'repo.sqlite'));
});

afterEach(() => {
  repoDb.close();
  rmSync(dir, { recursive: true, force: true });
});

function sessionInit(overrides: Partial<SessionInit> = {}): SessionInit {
  return {
    agent: 'claude-code',
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
    source: 'hooks',
    ...overrides,
  };
}

describe('TranscriptTaskSource.current', () => {
  test("derives the session's task from its own events", async () => {
    const session = repoDb.createSession(sessionInit());
    repoDb.appendEvents(session.id, [
      { sessionId: session.id, ts: 1001, kind: 'user_turn', payload: { text: 'fix the bug' } },
    ]);
    const source = new TranscriptTaskSource(repoDb);
    expect(await source.current(session)).toEqual({ text: 'fix the bug', source: 'transcript' });
  });

  test('returns null when nothing can be derived', async () => {
    const session = repoDb.createSession(sessionInit());
    const source = new TranscriptTaskSource(repoDb);
    expect(await source.current(session)).toBeNull();
  });
});

describe('TranscriptTaskSource.next', () => {
  test("reports the most recently started session's current task", async () => {
    const older = repoDb.createSession(sessionInit({ startedAt: 1000 }));
    repoDb.appendEvents(older.id, [
      { sessionId: older.id, ts: 1001, kind: 'user_turn', payload: { text: 'older task' } },
    ]);
    const newer = repoDb.createSession(sessionInit({ startedAt: 5000 }));
    repoDb.appendEvents(newer.id, [
      { sessionId: newer.id, ts: 5001, kind: 'user_turn', payload: { text: 'newer task' } },
    ]);

    const source = new TranscriptTaskSource(repoDb);
    expect(await source.next('/repo')).toEqual({ text: 'newer task', source: 'transcript' });
  });

  test('returns null when the repo has no sessions', async () => {
    const source = new TranscriptTaskSource(repoDb);
    expect(await source.next('/repo')).toBeNull();
  });
});
