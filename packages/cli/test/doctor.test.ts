import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noopLogger } from '@driftlock/core';
import { type DaemonHandle, startDaemon } from '@driftlock/daemon';
import { runDoctor } from '../src/doctor.ts';
import { runInit } from '../src/init.ts';

let base: string;
let repoDir: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalDriftlockHome: string | undefined;
let daemon: DaemonHandle | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'driftlock-doctor-test-'));
  repoDir = join(base, 'repo');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repoDir });

  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalDriftlockHome = process.env.DRIFTLOCK_HOME;
  // codexSessionsDir() reads USERPROFILE on win32, HOME everywhere else
  // (architecture doc §5.5) — both must be overridden for this fake home to
  // actually take effect regardless of which OS the test runs on.
  process.env.HOME = join(base, 'fake-home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.DRIFTLOCK_HOME = join(base, 'driftlock-home');
  mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  daemon?.stop();
  daemon = undefined;
  // biome-ignore lint/performance/noDelete: assigning undefined would stringify to "undefined"
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

describe('runDoctor', () => {
  test('reports the daemon as unreachable (warn) when it is not running', async () => {
    const report = await runDoctor(repoDir);
    const daemonCheck = report.checks.find((c) => c.name === 'daemon');
    expect(daemonCheck?.status).toBe('warn');
  });

  test('reports the daemon as ok and measures hook latency when it is running', async () => {
    daemon = await startDaemon({
      driftlockHomeDir: process.env.DRIFTLOCK_HOME as string,
      logger: noopLogger,
    });
    const report = await runDoctor(repoDir);
    expect(report.checks.find((c) => c.name === 'daemon')?.status).toBe('ok');
    expect(report.checks.find((c) => c.name === 'hook round-trip')?.status).toBe('ok');
  });

  test('reports repo not initialized when outside driftlock init', async () => {
    const report = await runDoctor(repoDir);
    expect(report.checks.find((c) => c.name === 'repo init')?.status).toBe('warn');
  });

  test('reports repo init and registry consistency ok after init', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });
    const report = await runDoctor(repoDir);
    expect(report.checks.find((c) => c.name === 'repo init')?.status).toBe('ok');
    expect(report.checks.find((c) => c.name === 'registry consistency')?.status).toBe('ok');
  });

  test('reports claude-code hooks wired after init with that agent', async () => {
    await runInit({ cwd: repoDir, agents: ['claude-code'] });
    const report = await runDoctor(repoDir);
    expect(report.checks.find((c) => c.name === 'claude-code hooks')?.status).toBe('ok');
  });

  test('warns when not inside a git repository', async () => {
    const nonRepo = join(base, 'not-a-repo');
    mkdirSync(nonRepo, { recursive: true });
    const report = await runDoctor(nonRepo);
    expect(report.checks.find((c) => c.name === 'repo')?.status).toBe('warn');
  });

  test('reports daemon.log as warn with no file yet', async () => {
    const report = await runDoctor(repoDir);
    const logCheck = report.checks.find((c) => c.name === 'daemon.log');
    expect(logCheck?.status).toBe('warn');
    expect(logCheck?.detail).toContain('no log file yet');
  });

  test('reports daemon.log as ok when there are no errors in it', async () => {
    mkdirSync(process.env.DRIFTLOCK_HOME as string, { recursive: true });
    const logPath = join(process.env.DRIFTLOCK_HOME as string, 'daemon.log');
    writeFileSync(
      logPath,
      `${JSON.stringify({ ts: Date.now(), level: 'info', component: 'daemon', msg: 'started' })}\n`,
    );

    const report = await runDoctor(repoDir);
    const logCheck = report.checks.find((c) => c.name === 'daemon.log');
    expect(logCheck?.status).toBe('ok');
  });

  test('surfaces the most recent error from daemon.log', async () => {
    mkdirSync(process.env.DRIFTLOCK_HOME as string, { recursive: true });
    const logPath = join(process.env.DRIFTLOCK_HOME as string, 'daemon.log');
    const lines = [
      { ts: 1000, level: 'info', component: 'daemon', msg: 'started' },
      { ts: 2000, level: 'error', component: 'daemon:watcher', msg: 'codex watcher scan failed' },
      { ts: 3000, level: 'info', component: 'daemon:server', msg: 'handled /hook' },
    ];
    writeFileSync(logPath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

    const report = await runDoctor(repoDir);
    const logCheck = report.checks.find((c) => c.name === 'daemon.log');
    expect(logCheck?.status).toBe('warn');
    expect(logCheck?.detail).toContain('codex watcher scan failed');
  });
});
