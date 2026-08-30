import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DaemonHandle, startDaemon } from '@driftlock/daemon';
import { runDoctor } from '../src/doctor.ts';
import { runInit } from '../src/init.ts';

let base: string;
let repoDir: string;
let originalHome: string | undefined;
let originalDriftlockHome: string | undefined;
let daemon: DaemonHandle | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'driftlock-doctor-test-'));
  repoDir = join(base, 'repo');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repoDir });

  originalHome = process.env.HOME;
  originalDriftlockHome = process.env.DRIFTLOCK_HOME;
  process.env.HOME = join(base, 'fake-home');
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
    daemon = await startDaemon({ driftlockHomeDir: process.env.DRIFTLOCK_HOME as string });
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
});
