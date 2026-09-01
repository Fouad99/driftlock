import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type RegistryStore,
  type RepoStore,
  openRegistryDb,
  openRepoDb,
} from '../src/store/index.ts';
import { refreshRepoGitState, syncSessionIndex } from '../src/store/session-index-sync.ts';

let dir: string;
let repoRoot: string;
let repoDb: RepoStore;
let registryDb: RegistryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driftlock-sync-test-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'driftlock-sync-repo-'));
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

describe('syncSessionIndex', () => {
  test('is a no-op for an unknown session id', () => {
    syncSessionIndex(registryDb, repoDb, 'repo-1', 'no-such-session');
    expect(registryDb.listSessionIndex('repo-1')).toHaveLength(0);
  });

  test('writes the severity breakdown, not just the total', () => {
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
    repoDb.createFinding({
      sessionId: session.id,
      analyzer: 'loop',
      severity: 'high',
      title: 'a',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });
    repoDb.createFinding({
      sessionId: session.id,
      analyzer: 'loop',
      severity: 'warn',
      title: 'b',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });

    syncSessionIndex(registryDb, repoDb, 'repo-1', session.id);

    const row = registryDb.listSessionIndex('repo-1')[0];
    expect(row?.openFindings).toBe(2);
    expect(row?.openFindingsBySeverity).toEqual({ info: 0, warn: 1, high: 1 });
  });

  test('also refreshes the repo git-state cache from disk', () => {
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'hello');

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

    syncSessionIndex(registryDb, repoDb, 'repo-1', session.id);

    const repo = registryDb.getRepo('repo-1');
    expect(repo?.gitStatus).toBe('dirty');
    expect(repo?.gitCheckedAt).toBeGreaterThan(0);
  });
});

describe('refreshRepoGitState', () => {
  test('is a no-op for an unregistered repo id', () => {
    refreshRepoGitState(registryDb, 'no-such-repo', repoRoot);
    expect(registryDb.getRepo('no-such-repo')).toBeNull();
  });
});
