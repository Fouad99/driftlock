import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RegistryStore, type RepoStore, openRegistryDb, openRepoDb } from '@driftlock/core';
import { resolveFindingMutation, setFindingPinnedMutation } from '../src/mutations.ts';

let dir: string;
let repoRoot: string;
let repoDb: RepoStore;
let registryDb: RegistryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driftlock-mutations-test-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'driftlock-mutations-repo-'));
  repoDb = openRepoDb(join(dir, 'repo.sqlite'));
  registryDb = openRegistryDb(join(dir, 'registry.sqlite'));
  registryDb.upsertRepo({
    repoId: 'repo-1',
    root: repoRoot,
    name: 'repo',
    agents: ['claude-code'],
    registeredAt: 1000,
    lastSeen: 1000,
  });
});

afterEach(() => {
  repoDb.close();
  registryDb.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

function seedSession(endedAt: number | null = 2000): string {
  const session = repoDb.createSession({
    agent: 'claude-code',
    agentSession: null,
    repoRoot,
    branch: null,
    headBefore: null,
    headAfter: null,
    startedAt: 1000,
    taskText: null,
    tokenIn: null,
    tokenOut: null,
    costUsd: null,
    source: 'hooks',
  });
  if (endedAt !== null) repoDb.endSession(session.id, endedAt, 'stop');
  return session.id;
}

describe('resolveFindingMutation', () => {
  test('returns null for an unknown finding id', () => {
    expect(resolveFindingMutation(repoDb, registryDb, 'repo-1', 'no-such-finding')).toBeNull();
  });

  test('resolves the finding and re-syncs the registry severity counts', () => {
    const sessionId = seedSession();
    const finding = repoDb.createFinding({
      sessionId,
      analyzer: 'loop',
      severity: 'warn',
      title: 'x',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });

    const result = resolveFindingMutation(repoDb, registryDb, 'repo-1', finding.id);
    expect(result?.resolvedAt).not.toBeNull();

    const row = registryDb.listSessionIndex('repo-1')[0];
    expect(row?.openFindingsBySeverity).toEqual({ info: 0, warn: 0, high: 0 });
  });
});

describe('setFindingPinnedMutation', () => {
  test('returns null for an unknown finding id', async () => {
    expect(await setFindingPinnedMutation(repoDb, repoRoot, 'no-such-finding', true)).toBeNull();
  });

  test('pins the finding and regenerates the latest brief so the pin is reflected immediately', async () => {
    const sessionId = seedSession();
    repoDb.appendEvents(sessionId, [
      { sessionId, ts: 1500, kind: 'agent_turn', payload: { text: 'did the thing' } },
    ]);
    const finding = repoDb.createFinding({
      sessionId,
      analyzer: 'loop',
      severity: 'high',
      title: 'stuck in a loop',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });

    const result = await setFindingPinnedMutation(repoDb, repoRoot, finding.id, true);
    expect(result?.pinned).toBe(true);

    const brief = repoDb.getBrief(sessionId);
    expect(brief?.markdown).toContain('stuck in a loop');
  });

  test('unpinning also regenerates the brief in place', async () => {
    const sessionId = seedSession();
    const finding = repoDb.createFinding({
      sessionId,
      analyzer: 'loop',
      severity: 'high',
      title: 'stuck in a loop',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });
    await setFindingPinnedMutation(repoDb, repoRoot, finding.id, true);

    const result = await setFindingPinnedMutation(repoDb, repoRoot, finding.id, false);
    expect(result?.pinned).toBe(false);
  });

  test('persists the pin even when no session has ended yet (brief regeneration no-ops)', async () => {
    const sessionId = seedSession(null);
    const finding = repoDb.createFinding({
      sessionId,
      analyzer: 'loop',
      severity: 'info',
      title: 'x',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });

    const result = await setFindingPinnedMutation(repoDb, repoRoot, finding.id, true);
    expect(result?.pinned).toBe(true);
    expect(repoDb.getLatestBrief()).toBeNull();
  });
});
