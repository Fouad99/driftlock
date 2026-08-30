import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/init.ts';
import { runReport } from '../src/report.ts';

let base: string;
let repoDir: string;
let originalHome: string | undefined;
let originalDriftlockHome: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'driftlock-cli-test-'));
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
  // biome-ignore lint/performance/noDelete: assigning `undefined` would stringify to "undefined" and break the restore
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  // biome-ignore lint/performance/noDelete: same as above
  if (originalDriftlockHome === undefined) delete process.env.DRIFTLOCK_HOME;
  else process.env.DRIFTLOCK_HOME = originalDriftlockHome;
  rmSync(base, { recursive: true, force: true });
});

function writeCodexFixture(repoRoot: string): void {
  const fixturePath = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    'fixtures',
    'codex',
    'session-1.jsonl',
  );
  const raw = readFileSync(fixturePath, 'utf-8');
  const rewritten = raw.replace('"cwd":"/repo"', `"cwd":${JSON.stringify(repoRoot)}`);
  const sessionsDir = join(process.env.HOME as string, '.codex', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, 'sess_x1.jsonl'), rewritten);
}

describe('runInit', () => {
  test('scaffolds .driftlock, DECISIONS.md, and the gitignore entry', async () => {
    const result = await runInit({ cwd: repoDir, agents: ['codex'] });

    expect(result.repoRoot).toBe(repoDir);
    expect(existsSync(join(repoDir, '.driftlock', 'db.sqlite'))).toBe(true);
    expect(existsSync(join(repoDir, '.driftlock', 'meta.json'))).toBe(true);
    expect(result.decisionsCreated).toBe(true);
    expect(existsSync(join(repoDir, 'DECISIONS.md'))).toBe(true);
    expect(result.gitignoreUpdated).toBe(true);
    expect(readFileSync(join(repoDir, '.gitignore'), 'utf-8')).toContain('.driftlock/');
  });

  test('is idempotent: re-running keeps the same repoId and does not duplicate the gitignore entry', async () => {
    const first = await runInit({ cwd: repoDir, agents: ['codex'] });
    const second = await runInit({ cwd: repoDir, agents: ['codex'] });

    expect(second.repoId).toBe(first.repoId);
    expect(second.gitignoreUpdated).toBe(false);
    expect(second.decisionsCreated).toBe(false);
    const gitignoreLines = readFileSync(join(repoDir, '.gitignore'), 'utf-8')
      .split('\n')
      .filter((l) => l.trim() === '.driftlock/');
    expect(gitignoreLines).toHaveLength(1);
  });

  test('errors outside a git repository', async () => {
    const nonRepo = join(base, 'not-a-repo');
    mkdirSync(nonRepo, { recursive: true });
    await expect(runInit({ cwd: nonRepo })).rejects.toThrow(/no git repository/);
  });
});

describe('runReport', () => {
  test('ingests a matching codex transcript and runs analyzers', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });
    writeCodexFixture(repoDir);

    const result = await runReport({ cwd: repoDir });

    expect(result.session.agent).toBe('codex');
    expect(result.session.taskText).toBe('Add rate limiting to the login endpoint');
    expect(result.events.length).toBeGreaterThan(0);
  });

  test('re-running report does not duplicate the ingested session', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });
    writeCodexFixture(repoDir);

    await runReport({ cwd: repoDir });
    const second = await runReport({ cwd: repoDir });

    expect(second.session.agentSession).toBe('sess_x1');
  });

  test('looking up an explicit unknown session id fails clearly', async () => {
    await runInit({ cwd: repoDir, agents: ['codex'] });
    await expect(runReport({ cwd: repoDir, sessionId: 'does-not-exist' })).rejects.toThrow(
      /no session/,
    );
  });
});
