import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driftlockDir, openRepoDb, repoDbPath } from '@driftlock/core';
import { runBrief } from '../src/brief.ts';
import { formatBrief, formatSessions } from '../src/format.ts';
import { runSessions } from '../src/sessions.ts';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'driftlock-cli-sessions-test-'));
  mkdirSync(driftlockDir(repoRoot), { recursive: true });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('runSessions', () => {
  test('lists sessions newest first with their open finding counts', async () => {
    const repoDb = openRepoDb(repoDbPath(repoRoot));
    const older = repoDb.createSession({
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
    const newer = repoDb.createSession({
      agent: 'codex',
      agentSession: null,
      repoRoot,
      branch: null,
      headBefore: null,
      headAfter: null,
      startedAt: 5000,
      taskText: null,
      tokenIn: null,
      tokenOut: null,
      costUsd: null,
      source: 'hooks',
    });
    repoDb.createFinding({
      sessionId: newer.id,
      analyzer: 'loop',
      severity: 'warn',
      title: 'looping',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });
    repoDb.close();

    const rows = await runSessions({ cwd: repoRoot, repoRoot });
    expect(rows.map((r) => r.session.id)).toEqual([newer.id, older.id]);
    expect(rows[0]?.openFindings).toBe(1);
    expect(rows[1]?.openFindings).toBe(0);
    expect(formatSessions(rows)).toContain('codex');
  });

  test('formats an empty list with a friendly message', async () => {
    const rows = await runSessions({ cwd: repoRoot, repoRoot });
    expect(rows).toEqual([]);
    expect(formatSessions(rows)).toContain('no sessions found');
  });
});

describe('runBrief', () => {
  test('returns null when no brief has been generated yet', async () => {
    const result = await runBrief({ cwd: repoRoot, repoRoot });
    expect(result.brief).toBeNull();
    expect(formatBrief(result.brief)).toContain('no resume brief yet');
  });

  test('returns the latest stored brief', async () => {
    const repoDb = openRepoDb(repoDbPath(repoRoot));
    repoDb.upsertBrief({ sessionId: 's1', generatedAt: 1000, markdown: '# Resume brief\nold' });
    repoDb.upsertBrief({ sessionId: 's2', generatedAt: 2000, markdown: '# Resume brief\nnew' });
    repoDb.close();

    const result = await runBrief({ cwd: repoRoot, repoRoot });
    expect(result.brief?.sessionId).toBe('s2');
    expect(formatBrief(result.brief)).toContain('new');
  });

  test('--write updates the fenced blocks from the stored brief', async () => {
    const repoDb = openRepoDb(repoDbPath(repoRoot));
    repoDb.upsertBrief({ sessionId: 's1', generatedAt: 1000, markdown: '# Resume brief\nhello' });
    repoDb.close();

    const result = await runBrief({ cwd: repoRoot, repoRoot, write: true });
    expect(result.written?.map((w) => w.path.split('/').pop())).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf-8')).toContain('hello');
  });

  test('--write with no brief yet is a no-op', async () => {
    const result = await runBrief({ cwd: repoRoot, repoRoot, write: true });
    expect(result.written).toBeUndefined();
    expect(existsSync(join(repoRoot, 'CLAUDE.md'))).toBe(false);
  });
});
