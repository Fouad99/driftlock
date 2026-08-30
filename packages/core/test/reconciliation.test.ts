import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionInit } from '../src/schema/session.ts';
import { fingerprintEvent } from '../src/store/event-fingerprint.ts';
import { type RepoStore, openRepoDb } from '../src/store/index.ts';

// M1' reconciliation design: Codex's hook and transcript ingestion paths can
// both describe the same real occurrence. These tests cover the store-layer
// primitives that make merging them safe — `mergeEvents`,
// `getOrCreateSessionByAgentSession`, and the `hook_backed` flag — including
// four bugs a reviewer found in earlier passes (see inline notes) that are
// each pinned here so they can't silently regress.

let dir: string;
let repoDb: RepoStore;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driftlock-reconciliation-test-'));
  dbPath = join(dir, 'repo.sqlite');
  repoDb = openRepoDb(dbPath);
});

afterEach(() => {
  repoDb.close();
  rmSync(dir, { recursive: true, force: true });
});

function sessionInit(overrides: Partial<SessionInit> = {}): SessionInit {
  return {
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
    source: 'hooks',
    ...overrides,
  };
}

describe('fingerprintEvent', () => {
  test('call-id kinds key on kind + id, independent of content', () => {
    expect(
      fingerprintEvent({
        kind: 'tool_call',
        ts: 1,
        payload: { callId: 'c1', name: 'Bash', args: {} },
      }),
    ).toBe('call:tool_call:c1');
    expect(
      fingerprintEvent({
        kind: 'tool_result',
        ts: 1,
        payload: { callId: 'c1', ok: true, output: 'x' },
      }),
    ).toBe('call:tool_result:c1');
  });

  test('file_edit includes the touched path — one apply_patch call can edit several files', () => {
    const a = fingerprintEvent({
      kind: 'file_edit',
      ts: 1,
      payload: { path: 'a.ts', hunks: [], callId: 'c1' },
    });
    const b = fingerprintEvent({
      kind: 'file_edit',
      ts: 1,
      payload: { path: 'b.ts', hunks: [], callId: 'c1' },
    });
    expect(a).not.toBe(b);
  });

  test('kinds with no natural identity return null', () => {
    expect(
      fingerprintEvent({
        kind: 'permission',
        ts: 1,
        payload: { tool: 'Edit', args: {}, decision: 'ask' },
      }),
    ).toBeNull();
  });
});

describe('getOrCreateSessionByAgentSession', () => {
  test('creates a new session when none exists for (agent, agentSession)', () => {
    const { session, created } = repoDb.getOrCreateSessionByAgentSession(
      sessionInit({ agentSession: 'codex-abc' }),
    );
    expect(created).toBe(true);
    expect(repoDb.getSessionByAgentSession('codex', 'codex-abc')?.id).toBe(session.id);
  });

  test('reuses an existing session instead of creating a duplicate', () => {
    // Simulates a Codex SessionStart hook arriving after the transcript
    // watcher already opened the same session (daemon restart mid-session).
    const opened = repoDb.createSession(
      sessionInit({ agentSession: 'codex-abc', source: 'transcript' }),
    );
    const { session, created } = repoDb.getOrCreateSessionByAgentSession(
      sessionInit({ agentSession: 'codex-abc', source: 'hooks' }),
    );
    expect(created).toBe(false);
    expect(session.id).toBe(opened.id);
    expect(repoDb.listSessions()).toHaveLength(1);
  });

  test('a null agentSession never merges — always creates a new session', () => {
    const a = repoDb.getOrCreateSessionByAgentSession(sessionInit({ agentSession: null }));
    const b = repoDb.getOrCreateSessionByAgentSession(sessionInit({ agentSession: null }));
    expect(a.session.id).not.toBe(b.session.id);
  });
});

describe('hook_backed', () => {
  test('a session starts out not hook-backed', () => {
    const session = repoDb.createSession(sessionInit());
    expect(repoDb.isSessionHookBacked(session.id)).toBe(false);
  });

  test('markSessionHookBacked flips it, with no event rows required', () => {
    // Regression: a session whose only hook activity is SessionStart +
    // SessionEnd (no tool calls, no prompts) writes zero `events` rows —
    // the flag must not depend on event presence.
    const session = repoDb.createSession(sessionInit());
    repoDb.markSessionHookBacked(session.id);
    expect(repoDb.isSessionHookBacked(session.id)).toBe(true);
    expect(repoDb.getEvents(session.id)).toHaveLength(0);
  });
});

describe('mergeEvents', () => {
  function hookSession(agentSession = 'codex-1'): string {
    return repoDb.createSession(sessionInit({ agentSession })).id;
  }

  test('never touches a hooks-owned row on an exact-key match', () => {
    const id = hookSession();
    repoDb.appendEvents(
      id,
      [
        {
          sessionId: id,
          ts: 1000,
          kind: 'tool_result',
          payload: { callId: 'c1', ok: true, output: 'orig' },
        },
      ],
      'hooks',
    );
    repoDb.mergeEvents(id, [
      {
        sessionId: id,
        ts: 1000,
        kind: 'tool_result',
        payload: { callId: 'c1', ok: false, output: 'DIFFERENT' },
      },
    ]);
    const [row] = repoDb.getEvents(id);
    expect(row?.payload).toEqual({ callId: 'c1', ok: true, output: 'orig' });
  });

  test('refreshes a transcript-owned row in place on idempotent re-sync', () => {
    const id = hookSession();
    // No hooks involved for this event — a plain transcript-only gap-fill,
    // then a second sync of the same growing transcript.
    repoDb.mergeEvents(id, [
      {
        sessionId: id,
        ts: 1000,
        kind: 'tool_result',
        payload: { callId: 'c1', ok: true, output: 'partial' },
      },
    ]);
    repoDb.mergeEvents(id, [
      {
        sessionId: id,
        ts: 1000,
        kind: 'tool_result',
        payload: { callId: 'c1', ok: true, output: 'full output' },
      },
    ]);
    const rows = repoDb.getEvents(id).filter((e) => e.kind === 'tool_result');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ callId: 'c1', ok: true, output: 'full output' });
  });

  test('gap-fills an event hooks never saw', () => {
    const id = hookSession();
    repoDb.mergeEvents(id, [
      { sessionId: id, ts: 1000, kind: 'file_read', payload: { path: 'a.ts' } },
    ]);
    expect(repoDb.getEvents(id).filter((e) => e.kind === 'file_read')).toHaveLength(1);
  });

  test('preserves seq of existing rows — never renumbers on merge', () => {
    const id = hookSession();
    repoDb.appendEvents(
      id,
      [
        {
          sessionId: id,
          ts: 1000,
          kind: 'tool_call',
          payload: { callId: 'c1', name: 'Bash', args: {} },
        },
      ],
      'hooks',
    );
    const [before] = repoDb.getEvents(id);
    repoDb.mergeEvents(id, [
      {
        sessionId: id,
        ts: 1000,
        kind: 'tool_call',
        payload: { callId: 'c1', name: 'Bash', args: {} },
      },
      { sessionId: id, ts: 1001, kind: 'file_read', payload: { path: 'a.ts' } },
    ]);
    const after = repoDb.getEvents(id);
    expect(after.find((e) => e.kind === 'tool_call')?.seq).toBe(before?.seq);
  });

  describe('occurrence-accounted matching (partial hook coverage)', () => {
    test('a genuinely missed second occurrence is gap-filled, not dropped', () => {
      const id = hookSession();
      // Hooks only captured one of two real, identical "continue" prompts
      // sent seconds apart (e.g. a missed delivery) — both fall in the same
      // 30s bucket and share a fingerprint.
      repoDb.appendEvents(
        id,
        [{ sessionId: id, ts: 2000, kind: 'user_turn', payload: { text: 'continue' } }],
        'hooks',
      );
      const result = repoDb.mergeEvents(id, [
        { sessionId: id, ts: 2000, kind: 'user_turn', payload: { text: 'continue' } }, // matches the hook row
        { sessionId: id, ts: 2005, kind: 'user_turn', payload: { text: 'continue' } }, // genuinely missed by hooks
      ]);
      expect(result.inserted).toBe(1);
      expect(repoDb.getEvents(id).filter((e) => e.kind === 'user_turn')).toHaveLength(2);
    });

    test('full hook coverage of a genuine loop is not duplicated', () => {
      const id = hookSession();
      const cmd = { command: 'npm test', exitCode: 1 };
      repoDb.appendEvents(
        id,
        [
          { sessionId: id, ts: 1000, kind: 'test_run', payload: cmd },
          { sessionId: id, ts: 1001, kind: 'test_run', payload: cmd },
          { sessionId: id, ts: 1002, kind: 'test_run', payload: cmd },
        ],
        'hooks',
      );
      const result = repoDb.mergeEvents(id, [
        { sessionId: id, ts: 1000, kind: 'test_run', payload: cmd },
        { sessionId: id, ts: 1001, kind: 'test_run', payload: cmd },
        { sessionId: id, ts: 1002, kind: 'test_run', payload: cmd },
      ]);
      expect(result.inserted).toBe(0);
      expect(repoDb.getEvents(id).filter((e) => e.kind === 'test_run')).toHaveLength(3);
    });
  });

  describe('agent_turn prefix enrichment', () => {
    test('extends a truncated hook payload in place, keeping seq', () => {
      const id = hookSession();
      repoDb.appendEvents(
        id,
        [{ sessionId: id, ts: 5000, kind: 'agent_turn', payload: { text: 'Done. Applying' } }],
        'hooks',
      );
      const [before] = repoDb.getEvents(id);
      const result = repoDb.mergeEvents(id, [
        {
          sessionId: id,
          ts: 5000,
          kind: 'agent_turn',
          payload: { text: 'Done. Applying the fix now.' },
        },
      ]);
      expect(result).toEqual({ inserted: 0, enriched: 1 });
      const [after] = repoDb.getEvents(id);
      expect(after?.seq).toBe(before?.seq);
      expect((after?.payload as { text: string }).text).toBe('Done. Applying the fix now.');
    });

    test('does not re-duplicate on a later sync of the same enriched text (dedupe_key kept in sync)', () => {
      const id = hookSession();
      repoDb.appendEvents(
        id,
        [{ sessionId: id, ts: 5000, kind: 'agent_turn', payload: { text: 'Done. Applying' } }],
        'hooks',
      );
      repoDb.mergeEvents(id, [
        {
          sessionId: id,
          ts: 5000,
          kind: 'agent_turn',
          payload: { text: 'Done. Applying the fix now.' },
        },
      ]);
      const result = repoDb.mergeEvents(id, [
        {
          sessionId: id,
          ts: 5000,
          kind: 'agent_turn',
          payload: { text: 'Done. Applying the fix now.' },
        },
      ]);
      expect(result).toEqual({ inserted: 0, enriched: 0 });
      expect(repoDb.getEvents(id).filter((e) => e.kind === 'agent_turn')).toHaveLength(1);
    });

    test('does not re-duplicate across an adjacent-bucket enrichment either', () => {
      // Hook fires at ts=29000 (bucket 0); the transcript's copy of the same
      // turn lands at ts=31000 (bucket 1) — the ±1 bucket tolerance this
      // exception exists for. Regression: the enrichment used to key the
      // merged row on the *hook's* timestamp, so a later sync (which always
      // re-fingerprints using the transcript's own, stable ts) looked up a
      // different bucket and missed its own past work.
      const id = hookSession();
      repoDb.appendEvents(
        id,
        [{ sessionId: id, ts: 29000, kind: 'agent_turn', payload: { text: 'Done. Applying' } }],
        'hooks',
      );
      repoDb.mergeEvents(id, [
        {
          sessionId: id,
          ts: 31000,
          kind: 'agent_turn',
          payload: { text: 'Done. Applying the fix now.' },
        },
      ]);
      const result = repoDb.mergeEvents(id, [
        {
          sessionId: id,
          ts: 31000,
          kind: 'agent_turn',
          payload: { text: 'Done. Applying the fix now.' },
        },
      ]);
      expect(result).toEqual({ inserted: 0, enriched: 0 });
      expect(repoDb.getEvents(id).filter((e) => e.kind === 'agent_turn')).toHaveLength(1);
    });

    test('does not enrich when the transcript text is not a strict prefix extension', () => {
      const id = hookSession();
      repoDb.appendEvents(
        id,
        [{ sessionId: id, ts: 5000, kind: 'agent_turn', payload: { text: 'Done. Applying' } }],
        'hooks',
      );
      const result = repoDb.mergeEvents(id, [
        {
          sessionId: id,
          ts: 5000,
          kind: 'agent_turn',
          payload: { text: 'A totally different message' },
        },
      ]);
      expect(result.enriched).toBe(0);
      // Not a prefix match, and content differs -> falls through to a
      // distinct gap-fill row rather than silently vanishing.
      expect(result.inserted).toBe(1);
    });

    test('does not enrich across buckets more than one apart', () => {
      const id = hookSession();
      repoDb.appendEvents(
        id,
        [{ sessionId: id, ts: 0, kind: 'agent_turn', payload: { text: 'Done. Applying' } }],
        'hooks',
      );
      // ts=90000 is bucket 3 vs. bucket 0 — outside the ±1 tolerance.
      const result = repoDb.mergeEvents(id, [
        {
          sessionId: id,
          ts: 90000,
          kind: 'agent_turn',
          payload: { text: 'Done. Applying the fix now.' },
        },
      ]);
      expect(result.enriched).toBe(0);
      expect(repoDb.getEvents(id).filter((e) => e.kind === 'agent_turn')).toHaveLength(2);
    });
  });
});

describe('events provenance migration (pre-existing DB without source/dedupe_key)', () => {
  test("backfills source from each row's parent session, not a blanket default", () => {
    // Build a DB on the OLD schema (no source/dedupe_key columns on
    // `events`) directly, bypassing RepoStore, then open it through
    // RepoStore and confirm the migration adds the columns and backfills
    // each row correctly from its own session — a blanket default would
    // mislabel one of these two sessions.
    const rawPath = join(dir, 'legacy.sqlite');
    const raw = new Database(rawPath, { create: true });
    raw.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, agent_session TEXT, repo_root TEXT NOT NULL,
        branch TEXT, head_before TEXT, head_after TEXT, started_at INTEGER NOT NULL,
        ended_at INTEGER, end_reason TEXT, task_text TEXT, token_in INTEGER, token_out INTEGER,
        cost_usd REAL, source TEXT NOT NULL
      );
      CREATE TABLE events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE findings (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, analyzer TEXT NOT NULL, severity TEXT NOT NULL,
        title TEXT NOT NULL, explanation TEXT NOT NULL, from_seq INTEGER, to_seq INTEGER, data TEXT,
        created_at INTEGER NOT NULL, resolved_at INTEGER
      );
      CREATE TABLE briefs (session_id TEXT PRIMARY KEY, generated_at INTEGER NOT NULL, markdown TEXT NOT NULL);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE applied_hook_envelopes (envelope_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    `);
    raw
      .query(
        `INSERT INTO sessions (id, agent, agent_session, repo_root, started_at, source)
         VALUES ('s-hooks', 'claude-code', null, '/repo', 1, 'hooks'),
                ('s-transcript', 'codex', null, '/repo', 1, 'transcript')`,
      )
      .run();
    raw
      .query(
        `INSERT INTO events (session_id, seq, ts, kind, payload) VALUES
           ('s-hooks', 0, 1, 'user_turn', '{"text":"hi"}'),
           ('s-transcript', 0, 1, 'user_turn', '{"text":"hi"}')`,
      )
      .run();
    raw.close();

    const migrated = openRepoDb(rawPath);
    try {
      const events = migrated.getEvents('s-hooks').concat(migrated.getEvents('s-transcript'));
      expect(events).toHaveLength(2);
      // Each row's parent-session-derived source is exercised indirectly
      // through hasHookSourcedEvents-equivalent behavior via hook_backed —
      // but source itself is checked with a raw query since it's not on
      // the public Event type.
      const raw2 = new Database(rawPath);
      const rows = raw2
        .query('SELECT session_id, source FROM events ORDER BY session_id')
        .all() as {
        session_id: string;
        source: string;
      }[];
      raw2.close();
      expect(rows).toEqual([
        { session_id: 's-hooks', source: 'hooks' },
        { session_id: 's-transcript', source: 'transcript' },
      ]);
    } finally {
      migrated.close();
    }
  });
});

describe('sessions.hook_backed migration (pre-existing DB without the column)', () => {
  test('backfills hook_backed = 1 only for sessions whose source was hooks', () => {
    const rawPath = join(dir, 'legacy2.sqlite');
    const raw = new Database(rawPath, { create: true });
    raw.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, agent_session TEXT, repo_root TEXT NOT NULL,
        branch TEXT, head_before TEXT, head_after TEXT, started_at INTEGER NOT NULL,
        ended_at INTEGER, end_reason TEXT, task_text TEXT, token_in INTEGER, token_out INTEGER,
        cost_usd REAL, source TEXT NOT NULL
      );
      CREATE TABLE events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE findings (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, analyzer TEXT NOT NULL, severity TEXT NOT NULL,
        title TEXT NOT NULL, explanation TEXT NOT NULL, from_seq INTEGER, to_seq INTEGER, data TEXT,
        created_at INTEGER NOT NULL, resolved_at INTEGER
      );
      CREATE TABLE briefs (session_id TEXT PRIMARY KEY, generated_at INTEGER NOT NULL, markdown TEXT NOT NULL);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE applied_hook_envelopes (envelope_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    `);
    raw
      .query(
        `INSERT INTO sessions (id, agent, agent_session, repo_root, started_at, source)
         VALUES ('s-hooks', 'claude-code', null, '/repo', 1, 'hooks'),
                ('s-transcript', 'codex', null, '/repo', 1, 'transcript')`,
      )
      .run();
    raw.close();

    const migrated = openRepoDb(rawPath);
    try {
      expect(migrated.isSessionHookBacked('s-hooks')).toBe(true);
      expect(migrated.isSessionHookBacked('s-transcript')).toBe(false);
    } finally {
      migrated.close();
    }
  });
});
