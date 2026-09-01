import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RegistryStore, type RepoStore, openRegistryDb, openRepoDb } from '@driftlock/core';
import {
  getCommitDetail,
  getEvidenceForFinding,
  getRepoRows,
  getSessionDetail,
  getTimelinePage,
} from '../src/queries.ts';

let dir: string;
let repoDb: RepoStore;
let registryDb: RegistryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driftlock-queries-test-'));
  repoDb = openRepoDb(join(dir, 'repo.sqlite'));
  registryDb = openRegistryDb(join(dir, 'registry.sqlite'));
});

afterEach(() => {
  repoDb.close();
  registryDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('getRepoRows', () => {
  test("sums per-severity counts across a repo's sessions and surfaces the latest session", () => {
    registryDb.upsertRepo({
      repoId: 'repo-1',
      root: '/repo',
      name: 'repo',
      agents: ['claude-code'],
      registeredAt: 1000,
      lastSeen: 1000,
    });
    registryDb.upsertSessionIndex({
      sessionId: 's-old',
      repoId: 'repo-1',
      agent: 'claude-code',
      startedAt: 1000,
      endedAt: 1500,
      openFindings: 1,
      openFindingsBySeverity: { info: 0, warn: 1, high: 0 },
    });
    registryDb.upsertSessionIndex({
      sessionId: 's-new',
      repoId: 'repo-1',
      agent: 'codex',
      startedAt: 5000,
      endedAt: null,
      openFindings: 1,
      openFindingsBySeverity: { info: 0, warn: 0, high: 1 },
    });

    const rows = getRepoRows(registryDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.openFindings).toEqual({ info: 0, warn: 1, high: 1 });
    expect(rows[0]?.latestSessionId).toBe('s-new');
    expect(rows[0]?.latestSessionAgent).toBe('codex');
    expect(rows[0]?.findingSparkline).toHaveLength(14);
  });
});

function seedSession(): string {
  const session = repoDb.createSession({
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
  });
  return session.id;
}

describe('getSessionDetail', () => {
  test('returns null for an unknown session', () => {
    expect(getSessionDetail(repoDb, 'no-such-session')).toBeNull();
  });

  test('surfaces linked commits from the commit_link finding, not a session column', () => {
    const sessionId = seedSession();
    repoDb.createFinding({
      sessionId,
      analyzer: 'commit_link',
      severity: 'info',
      title: '1 commit linked',
      explanation: 'abc..def',
      fromSeq: null,
      toSeq: null,
      data: { commits: ['abc123'], diffPaths: ['a.ts'] },
    });

    const detail = getSessionDetail(repoDb, sessionId);
    expect(detail?.linkedCommits).toEqual(['abc123']);
  });

  test('compactionCount reflects the whole session, independent of any timeline filter', () => {
    const sessionId = seedSession();
    repoDb.appendEvents(sessionId, [
      { sessionId, ts: 1000, kind: 'user_turn', payload: { text: 'hi' } },
      { sessionId, ts: 1001, kind: 'compaction', payload: {} },
      { sessionId, ts: 1002, kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
      { sessionId, ts: 1003, kind: 'compaction', payload: {} },
    ]);

    expect(getSessionDetail(repoDb, sessionId)?.compactionCount).toBe(2);
  });

  test('orders findings pinned-first', () => {
    const sessionId = seedSession();
    const older = repoDb.createFinding({
      sessionId,
      analyzer: 'loop',
      severity: 'warn',
      title: 'older',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });
    repoDb.createFinding({
      sessionId,
      analyzer: 'loop',
      severity: 'warn',
      title: 'newer',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });
    repoDb.setFindingPinned(older.id, true);

    const detail = getSessionDetail(repoDb, sessionId);
    expect(detail?.findings[0]?.id).toBe(older.id);
  });
});

describe('getTimelinePage', () => {
  test('"findings" is not a real event kind — it filters to seqs covered by an open finding', () => {
    const sessionId = seedSession();
    repoDb.appendEvents(
      sessionId,
      Array.from({ length: 6 }, (_, i) => ({
        sessionId,
        ts: 1000 + i,
        kind: 'user_turn' as const,
        payload: { text: `turn ${i}` },
      })),
    );
    repoDb.createFinding({
      sessionId,
      analyzer: 'loop',
      severity: 'warn',
      title: 'loop',
      explanation: 'x',
      fromSeq: 2,
      toSeq: 3,
      data: null,
    });

    const page = getTimelinePage(repoDb, sessionId, { filter: 'findings' });
    expect(page.events.map((e) => e.seq)).toEqual([2, 3]);
  });

  test('"edits" filters to file_edit events', () => {
    const sessionId = seedSession();
    repoDb.appendEvents(sessionId, [
      { sessionId, ts: 1000, kind: 'user_turn', payload: { text: 'hi' } },
      { sessionId, ts: 1001, kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
    ]);
    const page = getTimelinePage(repoDb, sessionId, { filter: 'edits' });
    expect(page.events.map((e) => e.kind)).toEqual(['file_edit']);
  });
});

describe('getEvidenceForFinding', () => {
  test('returns [] when the finding has no evidence range', () => {
    const sessionId = seedSession();
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
    expect(
      getEvidenceForFinding(
        repoDb,
        repoDb.getFinding(finding.id) as NonNullable<ReturnType<typeof repoDb.getFinding>>,
      ),
    ).toEqual([]);
  });
});

describe('getCommitDetail', () => {
  test('returns null for a sha shaped input that is not a valid ref', () => {
    expect(getCommitDetail('/does-not-exist', 'HEAD~1')).toBeNull();
  });
});
