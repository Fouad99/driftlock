import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type RegistryStore,
  type RepoStore,
  openRegistryDb,
  openRepoDb,
} from '../src/store/index.ts';

let dir: string;
let repoDb: RepoStore;
let registryDb: RegistryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driftlock-store-test-'));
  repoDb = openRepoDb(join(dir, 'repo.sqlite'));
  registryDb = openRegistryDb(join(dir, 'registry.sqlite'));
});

afterEach(() => {
  repoDb.close();
  registryDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('RepoStore', () => {
  test('migrates and records the schema version', () => {
    expect(repoDb.getMeta('schema_version')).toBe('1');
  });

  test('creates a session and reads it back', () => {
    const session = repoDb.createSession({
      agent: 'claude-code',
      agentSession: 'agent-1',
      repoRoot: '/repo',
      branch: 'main',
      headBefore: 'abc123',
      headAfter: null,
      startedAt: 1000,
      taskText: 'fix the bug',
      tokenIn: null,
      tokenOut: null,
      costUsd: null,
      source: 'hooks',
    });

    expect(session.id).toBeTruthy();
    expect(repoDb.getSession(session.id)).toEqual(session);
  });

  test('appends events with a monotonic per-session seq and reads them back in order', () => {
    const session = repoDb.createSession({
      agent: 'codex',
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
      source: 'transcript',
    });

    const seqs = repoDb.appendEvents(session.id, [
      { sessionId: session.id, ts: 1001, kind: 'user_turn', payload: { text: 'do the thing' } },
      { sessionId: session.id, ts: 1002, kind: 'session_end', payload: { reason: 'stop' } },
    ]);
    expect(seqs).toEqual([0, 1]);

    const more = repoDb.appendEvents(session.id, [
      { sessionId: session.id, ts: 1003, kind: 'user_turn', payload: { text: 'again' } },
    ]);
    expect(more).toEqual([2]);

    const events = repoDb.getEvents(session.id);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events[0]?.kind).toBe('user_turn');
    expect(events[0]?.payload).toEqual({ text: 'do the thing' });
  });

  test('filters events by kind and seq range', () => {
    const session = repoDb.createSession({
      agent: 'codex',
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
      source: 'transcript',
    });
    repoDb.appendEvents(session.id, [
      { sessionId: session.id, ts: 1, kind: 'user_turn', payload: { text: 'a' } },
      { sessionId: session.id, ts: 2, kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
      { sessionId: session.id, ts: 3, kind: 'test_run', payload: { command: 'test', exitCode: 0 } },
    ]);

    expect(repoDb.getEvents(session.id, { kinds: ['file_edit'] }).map((e) => e.kind)).toEqual([
      'file_edit',
    ]);
    expect(repoDb.getEvents(session.id, { from: 1, to: 1 }).map((e) => e.kind)).toEqual([
      'file_edit',
    ]);
  });

  test('creates, lists, and resolves findings', () => {
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

    const finding = repoDb.createFinding({
      sessionId: session.id,
      analyzer: 'loop',
      severity: 'warn',
      title: 'edit/test loop',
      explanation: '4 cycles on src/a.ts',
      fromSeq: 0,
      toSeq: 10,
      data: { path: 'src/a.ts' },
    });

    expect(repoDb.listFindings({ sessionId: session.id, open: true })).toHaveLength(1);
    repoDb.resolveFinding(finding.id, 2000);
    expect(repoDb.listFindings({ sessionId: session.id, open: true })).toHaveLength(0);
    expect(repoDb.getFinding(finding.id)?.resolvedAt).toBe(2000);
  });

  test('deleteOpenFindings() removes only unresolved findings for that session', () => {
    const session = repoDb.createSession({
      agent: 'codex',
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
      source: 'transcript',
    });
    const other = repoDb.createSession({
      agent: 'codex',
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
      source: 'transcript',
    });

    const resolved = repoDb.createFinding({
      sessionId: session.id,
      analyzer: 'loop',
      severity: 'warn',
      title: 'old finding, already resolved',
      explanation: '...',
      fromSeq: null,
      toSeq: null,
      data: null,
    });
    repoDb.resolveFinding(resolved.id, 2000);
    repoDb.createFinding({
      sessionId: session.id,
      analyzer: 'scope',
      severity: 'warn',
      title: 'stale finding from a prior analyzer run',
      explanation: '...',
      fromSeq: null,
      toSeq: null,
      data: null,
    });
    repoDb.createFinding({
      sessionId: other.id,
      analyzer: 'loop',
      severity: 'warn',
      title: 'a different session entirely',
      explanation: '...',
      fromSeq: null,
      toSeq: null,
      data: null,
    });

    repoDb.deleteOpenFindings(session.id);

    expect(repoDb.listFindings({ sessionId: session.id })).toHaveLength(1); // the resolved one survives
    expect(repoDb.getFinding(resolved.id)).not.toBeNull();
    expect(repoDb.listFindings({ sessionId: other.id })).toHaveLength(1); // untouched
  });

  test('reopenSession() clears endedAt and endReason', () => {
    const session = repoDb.createSession({
      agent: 'codex',
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
      source: 'transcript',
    });
    repoDb.endSession(session.id, 2000, 'idle');
    expect(repoDb.getSession(session.id)?.endedAt).toBe(2000);

    repoDb.reopenSession(session.id);

    const reopened = repoDb.getSession(session.id);
    expect(reopened?.endedAt).toBeNull();
    expect(reopened?.endReason).toBeNull();
  });

  test('upserts and reads a brief', () => {
    repoDb.upsertBrief({ sessionId: 'source-session', generatedAt: 1000, markdown: '# brief v1' });
    expect(repoDb.getBrief('source-session')?.markdown).toBe('# brief v1');
    repoDb.upsertBrief({ sessionId: 'source-session', generatedAt: 2000, markdown: '# brief v2' });
    expect(repoDb.getBrief('source-session')?.markdown).toBe('# brief v2');
  });

  test('getLatestBrief returns the most recently generated brief across sessions', () => {
    expect(repoDb.getLatestBrief()).toBeNull();
    repoDb.upsertBrief({ sessionId: 'session-a', generatedAt: 1000, markdown: '# a' });
    repoDb.upsertBrief({ sessionId: 'session-b', generatedAt: 3000, markdown: '# b' });
    repoDb.upsertBrief({ sessionId: 'session-c', generatedAt: 2000, markdown: '# c' });
    expect(repoDb.getLatestBrief()).toEqual({
      sessionId: 'session-b',
      generatedAt: 3000,
      markdown: '# b',
    });
  });

  test('transaction() commits all writes on success', () => {
    repoDb.transaction(() => {
      repoDb.setMeta('a', '1');
      repoDb.setMeta('b', '2');
    });
    expect(repoDb.getMeta('a')).toBe('1');
    expect(repoDb.getMeta('b')).toBe('2');
  });

  test('transaction() rolls back all writes if it throws', () => {
    expect(() =>
      repoDb.transaction(() => {
        repoDb.setMeta('c', '1');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(repoDb.getMeta('c')).toBeNull();
  });

  test('hasAppliedEnvelope() / tryClaimEnvelope() form an idempotency ledger', () => {
    expect(repoDb.hasAppliedEnvelope('env-1')).toBe(false);
    repoDb.tryClaimEnvelope('env-1', 1000);
    expect(repoDb.hasAppliedEnvelope('env-1')).toBe(true);
    expect(repoDb.hasAppliedEnvelope('env-2')).toBe(false);
  });

  test('tryClaimEnvelope() returns true exactly once for a given id — the atomic claim', () => {
    expect(repoDb.tryClaimEnvelope('env-1', 1000)).toBe(true);
    expect(repoDb.tryClaimEnvelope('env-1', 2000)).toBe(false); // second "concurrent" caller loses
    expect(repoDb.tryClaimEnvelope('env-1', 3000)).toBe(false); // and stays lost, not flaky
    expect(repoDb.hasAppliedEnvelope('env-1')).toBe(true);
  });

  test('setFindingPinned pins/unpins, and listFindings({pinnedFirst}) sorts pinned ahead of recency', () => {
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
    const older = repoDb.createFinding({
      sessionId: session.id,
      analyzer: 'loop',
      severity: 'warn',
      title: 'older',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });
    const newer = repoDb.createFinding({
      sessionId: session.id,
      analyzer: 'loop',
      severity: 'warn',
      title: 'newer',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });
    expect(repoDb.getFinding(older.id)?.pinned).toBe(false);

    repoDb.setFindingPinned(older.id, true);
    expect(repoDb.getFinding(older.id)?.pinned).toBe(true);

    const ordered = repoDb.listFindings({ sessionId: session.id, pinnedFirst: true });
    expect(ordered.map((f) => f.id)).toEqual([older.id, newer.id]);

    repoDb.setFindingPinned(older.id, false);
    expect(repoDb.getFinding(older.id)?.pinned).toBe(false);
  });

  test('countOpenFindingsBySeverity() breaks down by severity and excludes resolved findings', () => {
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
    const high = repoDb.createFinding({
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
    repoDb.createFinding({
      sessionId: session.id,
      analyzer: 'loop',
      severity: 'warn',
      title: 'c (resolved)',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });
    const resolved = repoDb
      .listFindings({ sessionId: session.id })
      .find((f) => f.title.includes('resolved'));
    repoDb.resolveFinding((resolved as NonNullable<typeof resolved>).id);

    expect(repoDb.countOpenFindingsBySeverity(session.id)).toEqual({ info: 0, warn: 1, high: 1 });
    expect(repoDb.getFinding(high.id)?.severity).toBe('high');
  });

  test('getEventPage() returns summaries (no full payload) with a stable cursor and maxSeq', () => {
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
    repoDb.appendEvents(
      session.id,
      Array.from({ length: 5 }, (_, i) => ({
        sessionId: session.id,
        ts: 1000 + i,
        kind: 'user_turn' as const,
        payload: { text: `turn ${i}` },
      })),
    );

    const page1 = repoDb.getEventPage(session.id, { limit: 2 });
    expect(page1.events).toHaveLength(2);
    expect(page1.events[0]).not.toHaveProperty('payload');
    expect(page1.events[0]?.summary).toBe('turn 0');
    expect(page1.maxSeq).toBe(4);
    expect(page1.nextFrom).toBe(2);

    const page2 = repoDb.getEventPage(session.id, { fromSeq: page1.nextFrom as number, limit: 2 });
    expect(page2.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(page2.nextFrom).toBe(4);

    const page3 = repoDb.getEventPage(session.id, { fromSeq: page2.nextFrom as number, limit: 2 });
    expect(page3.events.map((e) => e.seq)).toEqual([4]);
    expect(page3.nextFrom).toBeNull();
  });

  test('getEvidenceRange() returns a padded window of summaries around a seq range', () => {
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
    repoDb.appendEvents(
      session.id,
      Array.from({ length: 10 }, (_, i) => ({
        sessionId: session.id,
        ts: 1000 + i,
        kind: 'user_turn' as const,
        payload: { text: `turn ${i}` },
      })),
    );

    const evidence = repoDb.getEvidenceRange(session.id, 5, 6, 1);
    expect(evidence.map((e) => e.seq)).toEqual([4, 5, 6, 7]);

    // padding clamps the lower bound at 0, never goes negative
    const atStart = repoDb.getEvidenceRange(session.id, 0, 1, 3);
    expect(atStart.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  test('replaceEvents() deletes prior events and re-assigns seq from 0', () => {
    const session = repoDb.createSession({
      agent: 'codex',
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
      source: 'transcript',
    });
    repoDb.appendEvents(session.id, [
      { sessionId: session.id, ts: 1, kind: 'user_turn', payload: { text: 'first pass' } },
    ]);

    const seqs = repoDb.replaceEvents(session.id, [
      { sessionId: session.id, ts: 1, kind: 'user_turn', payload: { text: 'a' } },
      { sessionId: session.id, ts: 2, kind: 'agent_turn', payload: { text: 'b' } },
    ]);

    expect(seqs).toEqual([0, 1]);
    const events = repoDb.getEvents(session.id);
    expect(events).toHaveLength(2);
    expect(events[0]?.payload).toEqual({ text: 'a' });
  });
});

describe('RegistryStore', () => {
  test('upserts and lists repos', () => {
    registryDb.upsertRepo({
      repoId: 'repo-1',
      root: '/repo',
      name: 'driftlock',
      agents: ['claude-code'],
      registeredAt: 1000,
      lastSeen: 1000,
    });
    expect(registryDb.getRepoByRoot('/repo')?.repoId).toBe('repo-1');
    expect(registryDb.listRepos()).toHaveLength(1);

    registryDb.upsertRepo({
      repoId: 'repo-1',
      root: '/repo',
      name: 'driftlock',
      agents: ['claude-code', 'codex'],
      registeredAt: 1000,
      lastSeen: 2000,
    });
    expect(registryDb.getRepo('repo-1')?.agents).toEqual(['claude-code', 'codex']);
  });

  test('upserts session index rows', () => {
    registryDb.upsertSessionIndex({
      sessionId: 's-1',
      repoId: 'repo-1',
      agent: 'codex',
      startedAt: 1000,
      endedAt: null,
      openFindings: 2,
    });
    expect(registryDb.listSessionIndex('repo-1')).toHaveLength(1);

    registryDb.upsertSessionIndex({
      sessionId: 's-1',
      repoId: 'repo-1',
      agent: 'codex',
      startedAt: 1000,
      endedAt: 1500,
      openFindings: 0,
    });
    const rows = registryDb.listSessionIndex('repo-1');
    expect(rows[0]?.openFindings).toBe(0);
    expect(rows[0]?.endedAt).toBe(1500);
  });

  test('stores daemon state', () => {
    expect(registryDb.getDaemonState('port')).toBeNull();
    registryDb.setDaemonState('port', '4711');
    expect(registryDb.getDaemonState('port')).toBe('4711');
  });

  test('upsertRepo defaults branch/gitStatus/gitCheckedAt to "not probed yet" when omitted', () => {
    registryDb.upsertRepo({
      repoId: 'repo-2',
      root: '/repo2',
      name: 'repo2',
      agents: ['codex'],
      registeredAt: 1000,
      lastSeen: 1000,
    });
    const repo = registryDb.getRepo('repo-2');
    expect(repo?.branch).toBeNull();
    expect(repo?.gitStatus).toBe('unavailable');
    expect(repo?.gitCheckedAt).toBeNull();
  });

  test('updateRepoGitState refreshes only the git-state columns, not identity fields', () => {
    registryDb.upsertRepo({
      repoId: 'repo-3',
      root: '/repo3',
      name: 'repo3',
      agents: ['codex'],
      registeredAt: 1000,
      lastSeen: 1000,
    });
    registryDb.updateRepoGitState('repo-3', {
      branch: 'main',
      gitStatus: 'dirty',
      gitCheckedAt: 5000,
    });
    const repo = registryDb.getRepo('repo-3');
    expect(repo?.branch).toBe('main');
    expect(repo?.gitStatus).toBe('dirty');
    expect(repo?.gitCheckedAt).toBe(5000);
    expect(repo?.name).toBe('repo3');
  });

  test('upsertSessionIndex defaults openFindingsBySeverity to all-zero when omitted', () => {
    registryDb.upsertSessionIndex({
      sessionId: 's-2',
      repoId: 'repo-1',
      agent: 'codex',
      startedAt: 1000,
      endedAt: null,
      openFindings: 3,
    });
    expect(registryDb.listSessionIndex('repo-1')[0]?.openFindingsBySeverity).toEqual({
      info: 0,
      warn: 0,
      high: 0,
    });
  });

  test('upserts and reads back the severity breakdown', () => {
    registryDb.upsertSessionIndex({
      sessionId: 's-3',
      repoId: 'repo-1',
      agent: 'codex',
      startedAt: 1000,
      endedAt: null,
      openFindings: 3,
      openFindingsBySeverity: { info: 1, warn: 1, high: 1 },
    });
    expect(registryDb.listSessionIndex('repo-1')[0]?.openFindingsBySeverity).toEqual({
      info: 1,
      warn: 1,
      high: 1,
    });
  });

  test('getLatestSessionIndex returns the most recently started session for a repo', () => {
    registryDb.upsertSessionIndex({
      sessionId: 's-old',
      repoId: 'repo-4',
      agent: 'codex',
      startedAt: 1000,
      endedAt: 1500,
      openFindings: 0,
    });
    registryDb.upsertSessionIndex({
      sessionId: 's-new',
      repoId: 'repo-4',
      agent: 'claude-code',
      startedAt: 5000,
      endedAt: null,
      openFindings: 0,
    });
    expect(registryDb.getLatestSessionIndex('repo-4')?.sessionId).toBe('s-new');
    expect(registryDb.getLatestSessionIndex('no-such-repo')).toBeNull();
  });

  test('getFindingSparkline zero-fills 14 days and buckets by session startedAt day', () => {
    const today = Date.now();
    registryDb.upsertSessionIndex({
      sessionId: 's-today',
      repoId: 'repo-5',
      agent: 'codex',
      startedAt: today,
      endedAt: null,
      openFindings: 3,
    });
    const buckets = registryDb.getFindingSparkline('repo-5');
    expect(buckets).toHaveLength(14);
    expect(buckets.at(-1)?.count).toBe(3);
    expect(buckets.slice(0, -1).every((b) => b.count === 0)).toBe(true);
  });
});
