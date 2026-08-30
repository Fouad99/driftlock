import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/init.ts';
import { runReport } from '../src/report.ts';
import { runStatus } from '../src/status.ts';

let base: string;
let repoDir: string;
let originalHome: string | undefined;
let originalDriftlockHome: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'driftlock-status-test-'));
  repoDir = join(base, 'repo');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

  originalHome = process.env.HOME;
  originalDriftlockHome = process.env.DRIFTLOCK_HOME;
  process.env.HOME = join(base, 'fake-home');
  process.env.DRIFTLOCK_HOME = join(base, 'driftlock-home');
  mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: assigning undefined would stringify to "undefined"
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  // biome-ignore lint/performance/noDelete: same as above
  if (originalDriftlockHome === undefined) delete process.env.DRIFTLOCK_HOME;
  else process.env.DRIFTLOCK_HOME = originalDriftlockHome;
  rmSync(base, { recursive: true, force: true });
});

describe('runStatus', () => {
  test('returns an empty list with no registered repos', async () => {
    const rows = await runStatus();
    expect(rows).toEqual([]);
  });

  test('lists a registered repo even with no sessions yet', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });
    const rows = await runStatus();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.root).toBe(repoDir);
    expect(rows[0]?.lastSessionAt).toBeNull();
    expect(rows[0]?.openFindings).toBe(0);
  });

  test('reflects a session and its findings once report has run', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });

    const fixturePath = join(
      import.meta.dir,
      '..',
      '..',
      '..',
      'fixtures',
      'codex',
      'session-2.jsonl',
    );
    const raw = await Bun.file(fixturePath).text();
    const rewritten = raw.replace('"cwd":"/repo"', `"cwd":${JSON.stringify(repoDir)}`);
    const sessionsDir = join(process.env.HOME as string, '.codex', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    await Bun.write(join(sessionsDir, 'sess.jsonl'), rewritten);

    await runReport({ cwd: repoDir });

    const rows = await runStatus();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent).toBe('codex');
    expect(rows[0]?.lastSessionAt).not.toBeNull();
    expect(rows[0]?.openFindings).toBeGreaterThan(0);
  });

  test('reports dirty branch state via git', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });

    // untracked file makes the repo dirty
    await Bun.write(join(repoDir, 'untracked.txt'), 'hi');

    const rows = await runStatus();
    expect(rows[0]?.dirty).toBe(true);
  });
});
