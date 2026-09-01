import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRepoDb, repoDbPath } from '@driftlock/core';
import { runCommitShow } from '../src/commit-show.ts';
import { runInit } from '../src/init.ts';
import { runPin } from '../src/pin.ts';
import { runResolve } from '../src/resolve.ts';

let base: string;
let repoDir: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalDriftlockHome: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'driftlock-cli-mutation-test-'));
  repoDir = join(base, 'repo');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalDriftlockHome = process.env.DRIFTLOCK_HOME;
  process.env.HOME = join(base, 'fake-home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.DRIFTLOCK_HOME = join(base, 'driftlock-home');
  mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: assigning `undefined` would stringify to "undefined" and break the restore
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  // biome-ignore lint/performance/noDelete: same as above
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  // biome-ignore lint/performance/noDelete: same as above
  if (originalDriftlockHome === undefined) delete process.env.DRIFTLOCK_HOME;
  else process.env.DRIFTLOCK_HOME = originalDriftlockHome;
  rmSync(base, { recursive: true, force: true });
});

function seedFinding(): string {
  const repoDb = openRepoDb(repoDbPath(repoDir));
  const session = repoDb.createSession({
    agent: 'claude-code',
    agentSession: null,
    repoRoot: repoDir,
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
  repoDb.endSession(session.id, 2000, 'stop');
  const finding = repoDb.createFinding({
    sessionId: session.id,
    analyzer: 'loop',
    severity: 'warn',
    title: 'stuck in a loop',
    explanation: 'x',
    fromSeq: null,
    toSeq: null,
    data: null,
  });
  repoDb.close();
  return finding.id;
}

describe('runResolve', () => {
  test('resolves a finding by id', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });
    const findingId = seedFinding();

    const resolved = await runResolve({ cwd: repoDir, findingId });
    expect(resolved.resolvedAt).not.toBeNull();
  });

  test('errors for an unknown finding id', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });
    await expect(runResolve({ cwd: repoDir, findingId: 'no-such-finding' })).rejects.toThrow(
      /no finding/,
    );
  });
});

describe('runPin', () => {
  test('pins and unpins a finding', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });
    const findingId = seedFinding();

    const pinned = await runPin({ cwd: repoDir, findingId, pinned: true });
    expect(pinned.pinned).toBe(true);

    const unpinned = await runPin({ cwd: repoDir, findingId, pinned: false });
    expect(unpinned.pinned).toBe(false);
  });
});

describe('runCommitShow', () => {
  test('shows a real commit', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });
    writeFileSync(join(repoDir, 'a.txt'), 'hello');
    execFileSync('git', ['add', 'a.txt'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'add a.txt'], { cwd: repoDir });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim();

    const commit = runCommitShow({ cwd: repoDir, sha });
    expect(commit.show).toContain('add a.txt');
  });

  test('errors for a sha that does not resolve to a commit', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });
    expect(() => runCommitShow({ cwd: repoDir, sha: 'deadbeef' })).toThrow(/not found/);
  });
});
