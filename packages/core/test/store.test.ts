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

  test('upserts and reads a brief', () => {
    repoDb.upsertBrief({ sessionId: 'next-session', generatedAt: 1000, markdown: '# brief v1' });
    expect(repoDb.getBrief('next-session')?.markdown).toBe('# brief v1');
    repoDb.upsertBrief({ sessionId: 'next-session', generatedAt: 2000, markdown: '# brief v2' });
    expect(repoDb.getBrief('next-session')?.markdown).toBe('# brief v2');
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
});
