import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRepoDb, repoDbPath } from '@driftlock/core';
import { type DaemonHandle, startDaemon } from '@driftlock/daemon';
import { runInit } from '../src/init.ts';
import { runPin } from '../src/pin.ts';
import { runResolve } from '../src/resolve.ts';

// Proves the M3 requirement that a CLI mutation is visible over SSE when a
// daemon is running (05-UI.md §4.2: "the CLI routes mutations through the
// daemon's HTTP API when one is available") — a direct DB write from this
// process would never reach the daemon's in-process update bus, so
// receiving an SSE event here is only possible if `runResolve`/`runPin`
// actually went through the daemon's `/api/*`, not around it.

let base: string;
let repoDir: string;
let home: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalDriftlockHome: string | undefined;
let daemon: DaemonHandle | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'driftlock-daemon-routed-test-'));
  repoDir = join(base, 'repo');
  home = join(base, 'driftlock-home');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalDriftlockHome = process.env.DRIFTLOCK_HOME;
  process.env.HOME = join(base, 'fake-home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.DRIFTLOCK_HOME = home;
  mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  daemon?.stop();
  daemon = undefined;
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

async function readSseUntil(res: Response, marker: string, timeoutMs = 3000): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let received = '';
  const deadline = Date.now() + timeoutMs;
  while (!received.includes(marker) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value);
  }
  await reader.cancel();
  return received;
}

describe('CLI mutations routed through a running daemon', () => {
  test('runResolve publishes an SSE event when a daemon is up', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });
    const findingId = seedFinding();

    daemon = await startDaemon({ driftlockHomeDir: home });
    const sse = await fetch(`http://127.0.0.1:${daemon.port}/api/events`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    await new Promise((r) => setTimeout(r, 30)); // let the subscription attach

    const resolved = await runResolve({ cwd: repoDir, findingId });
    expect(resolved.resolvedAt).not.toBeNull();

    const received = await readSseUntil(sse, 'session_updated');
    expect(received).toContain('session_updated');
    expect(received).toContain('repo_updated');
  });

  test('runPin publishes an SSE event when a daemon is up', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });
    const findingId = seedFinding();

    daemon = await startDaemon({ driftlockHomeDir: home });
    const sse = await fetch(`http://127.0.0.1:${daemon.port}/api/events`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    await new Promise((r) => setTimeout(r, 30));

    const pinned = await runPin({ cwd: repoDir, findingId, pinned: true });
    expect(pinned.pinned).toBe(true);

    const received = await readSseUntil(sse, 'session_updated');
    expect(received).toContain('session_updated');
  });

  test('falls back to a direct DB write when no daemon is running', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });
    const findingId = seedFinding();

    // No daemon started — daemon.json doesn't exist.
    const resolved = await runResolve({ cwd: repoDir, findingId });
    expect(resolved.resolvedAt).not.toBeNull();
  });
});
