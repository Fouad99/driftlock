import { Database } from 'bun:sqlite';
import { monotonicFactory } from 'ulid';
import type { Brief } from '../schema/brief.ts';
import type { Event, NewEvent } from '../schema/event.ts';
import type { Finding, NewFinding } from '../schema/finding.ts';
import type { Session, SessionInit } from '../schema/session.ts';
import { eventTimeBucket, fingerprintEvent } from './event-fingerprint.ts';
import { REPO_DB_MIGRATIONS } from './migrations.ts';

export type EventSource = 'hooks' | 'transcript';

const ulid = monotonicFactory();

const SCHEMA_VERSION = '1';

function toSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    agent: row.agent as Session['agent'],
    agentSession: (row.agent_session as string | null) ?? null,
    repoRoot: row.repo_root as string,
    branch: (row.branch as string | null) ?? null,
    headBefore: (row.head_before as string | null) ?? null,
    headAfter: (row.head_after as string | null) ?? null,
    startedAt: row.started_at as number,
    endedAt: (row.ended_at as number | null) ?? null,
    endReason: (row.end_reason as string | null) ?? null,
    taskText: (row.task_text as string | null) ?? null,
    tokenIn: (row.token_in as number | null) ?? null,
    tokenOut: (row.token_out as number | null) ?? null,
    costUsd: (row.cost_usd as number | null) ?? null,
    source: row.source as Session['source'],
  };
}

function toEvent(row: Record<string, unknown>): Event {
  return {
    sessionId: row.session_id as string,
    seq: row.seq as number,
    ts: row.ts as number,
    kind: row.kind as Event['kind'],
    payload: JSON.parse(row.payload as string),
  } as Event;
}

function toBrief(row: Record<string, unknown>): Brief {
  return {
    sessionId: row.session_id as string,
    generatedAt: row.generated_at as number,
    markdown: row.markdown as string,
  };
}

function toFinding(row: Record<string, unknown>): Finding {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    analyzer: row.analyzer as string,
    severity: row.severity as Finding['severity'],
    title: row.title as string,
    explanation: row.explanation as string,
    fromSeq: (row.from_seq as number | null) ?? null,
    toSeq: (row.to_seq as number | null) ?? null,
    data: row.data ? JSON.parse(row.data as string) : null,
    createdAt: row.created_at as number,
    resolvedAt: (row.resolved_at as number | null) ?? null,
  };
}

export class RepoStore {
  readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.transaction(() => {
      for (const stmt of REPO_DB_MIGRATIONS) {
        this.db.exec(stmt);
      }
      this.migrateEventProvenanceColumns();
      this.migrateSessionHookBackedColumn();
      const existing = this.getMeta('schema_version');
      if (existing === null) {
        this.setMeta('schema_version', SCHEMA_VERSION);
      }
    })();
  }

  /**
   * Adds `events.source`/`events.dedupe_key` (M1' reconciliation design) on
   * top of the base `CREATE TABLE IF NOT EXISTS` migration, which can't
   * retroactively add columns to a pre-existing table. Safe to run on every
   * open: `ALTER TABLE ADD COLUMN` and the backfill only fire once, guarded
   * by `PRAGMA table_info`.
   *
   * The backfill labels each pre-existing row with its *parent session's*
   * `source` — a blanket default of either value would mislabel history
   * (every Claude Code row is genuinely hook-sourced; every pre-M1'
   * Codex row is genuinely transcript-sourced). `dedupe_key` is left NULL
   * on backfilled rows: recomputing a fingerprint for historical data isn't
   * needed since there's nothing yet to protect it from being overwritten by.
   */
  private migrateEventProvenanceColumns(): void {
    const cols = this.db.query('PRAGMA table_info(events)').all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('source')) {
      this.db.exec('ALTER TABLE events ADD COLUMN source TEXT');
      this.db.exec(
        `UPDATE events SET source = (SELECT source FROM sessions WHERE sessions.id = events.session_id)
         WHERE source IS NULL`,
      );
    }
    if (!names.has('dedupe_key')) {
      this.db.exec('ALTER TABLE events ADD COLUMN dedupe_key TEXT');
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_dedupe_key ON events(session_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND dedupe_key LIKE 'call:%'",
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_events_session_source ON events(session_id, source)',
    );
  }

  /**
   * Adds `sessions.hook_backed` — the authoritative "has a real hook ever
   * touched this session" flag, set explicitly by `apply-adapter-output.ts`
   * whenever it applies a hook output (`session_start`/`events`/
   * `session_end`) for a session. This is NOT derivable from "does this
   * session have any event row with `source = 'hooks'`": a session whose
   * hook activity was only `SessionStart` + `SessionEnd` (no tool calls,
   * no prompts — nothing that produces an `events` row) is genuinely
   * hook-backed but would have zero hook-sourced event rows, and the
   * transcript watcher's idle-reopen logic must still treat it as final.
   *
   * Backfilled from `sessions.source = 'hooks'` — correct for what a
   * session's provenance was *at creation*, and the only thing knowable
   * retroactively; a session that only became hook-backed later (hooks
   * arriving after a transcript-opened session) has no historical record
   * of that transition to recover.
   */
  private migrateSessionHookBackedColumn(): void {
    const cols = this.db.query('PRAGMA table_info(sessions)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'hook_backed')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN hook_backed INTEGER NOT NULL DEFAULT 0');
      this.db.exec("UPDATE sessions SET hook_backed = 1 WHERE source = 'hooks'");
    }
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` atomically — all its writes commit together, or none do. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- hook idempotency ---

  hasAppliedEnvelope(envelopeId: string): boolean {
    return (
      this.db
        .query('SELECT 1 FROM applied_hook_envelopes WHERE envelope_id = ?')
        .get(envelopeId) !== null
    );
  }

  /**
   * Atomically claims an envelope id: returns `true` and reserves it (this
   * call is the only one that will ever return `true` for this id) if it
   * wasn't already claimed, `false` if it was. This is a single SQL
   * statement — unlike a separate `hasAppliedEnvelope` check followed later
   * by a mark, there's no window between the two where two concurrent
   * callers could both see "not yet applied" and both proceed to apply.
   * Callers should claim first, then do the actual work inside the same
   * `transaction()` so a failure rolls back the claim along with everything
   * else (see daemon's `hook-handler.ts`).
   */
  tryClaimEnvelope(envelopeId: string, appliedAt: number = Date.now()): boolean {
    const result = this.db
      .query('INSERT OR IGNORE INTO applied_hook_envelopes (envelope_id, applied_at) VALUES (?, ?)')
      .run(envelopeId, appliedAt);
    return result.changes > 0;
  }

  /**
   * Releases a claim made by `tryClaimEnvelope` when it turns out nothing
   * was actually applied (e.g. the output kind was unrecognized, or its
   * session_start hadn't arrived yet). Without this, a no-op envelope would
   * stay permanently marked applied and could never be retried once its
   * prerequisites do show up. Safe under concurrent identical no-op
   * deliveries: each caller independently claims-then-unclaims inside its
   * own transaction, and no real mutation happens either way.
   */
  unclaimEnvelope(envelopeId: string): void {
    this.db.query('DELETE FROM applied_hook_envelopes WHERE envelope_id = ?').run(envelopeId);
  }

  // --- meta ---

  getMeta(key: string): string | null {
    const row = this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  // --- sessions ---

  createSession(init: SessionInit): Session {
    const id = init.id ?? ulid();
    this.db
      .query(
        `INSERT INTO sessions
          (id, agent, agent_session, repo_root, branch, head_before, head_after,
           started_at, ended_at, end_reason, task_text, token_in, token_out, cost_usd, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        init.agent,
        init.agentSession,
        init.repoRoot,
        init.branch,
        init.headBefore,
        init.headAfter,
        init.startedAt,
        init.taskText,
        init.tokenIn,
        init.tokenOut,
        init.costUsd,
        init.source,
      );
    return this.getSession(id) as Session;
  }

  getSession(id: string): Session | null {
    const row = this.db.query('SELECT * FROM sessions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toSession(row) : null;
  }

  getSessionByAgentSession(agent: Session['agent'], agentSession: string): Session | null {
    const row = this.db
      .query('SELECT * FROM sessions WHERE agent = ? AND agent_session = ?')
      .get(agent, agentSession) as Record<string, unknown> | undefined;
    return row ? toSession(row) : null;
  }

  /**
   * Finds a session by `(agent, agentSession)` and reuses it if one already
   * exists, rather than creating a duplicate. Centralized here — not in
   * each adapter or ingestion path — because adapters don't have a
   * `RepoStore` (`AdapterContext` only carries a `RepoRef`), and both the
   * push path (a hook's `SessionStart` output, applied in
   * `apply-adapter-output.ts`) and the pull path (the transcript watcher's
   * `ingest.ts`) need the identical identity rule. Without it, a Codex
   * `SessionStart` hook arriving after the transcript watcher already
   * opened the same session (e.g. the daemon restarted mid-session) would
   * either collide on `agent_session` or fork into two divergent sessions
   * for what's really one.
   */
  getOrCreateSessionByAgentSession(init: SessionInit): { session: Session; created: boolean } {
    if (init.agentSession) {
      const existing = this.getSessionByAgentSession(init.agent, init.agentSession);
      if (existing) return { session: existing, created: false };
    }
    return { session: this.createSession(init), created: true };
  }

  endSession(id: string, endedAt: number, reason: string, headAfter?: string | null): void {
    this.db
      .query(
        'UPDATE sessions SET ended_at = ?, end_reason = ?, head_after = COALESCE(?, head_after) WHERE id = ?',
      )
      .run(endedAt, reason, headAfter ?? null, id);
  }

  /** Un-finalizes a session — for a heuristic "ended" call (Codex idle-finalization) that later turns out to be wrong. */
  reopenSession(id: string): void {
    this.db.query('UPDATE sessions SET ended_at = NULL, end_reason = NULL WHERE id = ?').run(id);
  }

  listSessions(opts: { limit?: number; before?: number } = {}): Session[] {
    const limit = opts.limit ?? 20;
    const rows = (
      opts.before
        ? this.db
            .query('SELECT * FROM sessions WHERE started_at < ? ORDER BY started_at DESC LIMIT ?')
            .all(opts.before, limit)
        : this.db.query('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[];
    return rows.map(toSession);
  }

  // --- events ---

  /**
   * Appends events, assigning a monotonic `seq` per session. Returns the
   * seqs actually written. Every event gets a `dedupe_key` (see
   * `fingerprintEvent`) so a later transcript merge (`mergeEvents`) can
   * find it, but only `call:`-prefixed keys (a real, shared tool call id)
   * are DB-enforced unique per session — a collision there really is
   * duplicate delivery of the same occurrence, defense in depth alongside
   * the envelope-level idempotency claim in `hook-handler.ts`, skipped via
   * `ON CONFLICT ... DO NOTHING`.
   *
   * The content+time-bucket fallback keys (`user_turn`, `agent_turn`,
   * `compaction`, callId-less `test_run`/`file_edit`) are deliberately
   * NOT unique-enforced: two genuinely distinct real events — e.g. the
   * same failing test command run three times in a row, the exact
   * scenario the `loop` analyzer exists to catch — legitimately share one.
   * Enforcing uniqueness there would silently collapse real repeats into a
   * single row. Those keys exist only as an application-level lookup hint
   * for `mergeEvents`, never as a database constraint.
   */
  appendEvents(sessionId: string, events: NewEvent[], source: EventSource = 'hooks'): number[] {
    const nextSeqRow = this.db
      .query('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE session_id = ?')
      .get(sessionId) as { next: number };
    let seq = nextSeqRow.next;
    const insert = this.db.query(
      `INSERT INTO events (session_id, seq, ts, kind, payload, source, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND dedupe_key LIKE 'call:%' DO NOTHING`,
    );
    const seqs: number[] = [];
    this.db.transaction(() => {
      for (const e of events) {
        const key = fingerprintEvent(e);
        const result = insert.run(
          sessionId,
          seq,
          e.ts,
          e.kind,
          JSON.stringify(e.payload),
          source,
          key,
        );
        if (result.changes > 0) seqs.push(seq);
        seq += 1; // always advance so later events in this batch keep unique seqs even when one is skipped
      }
    })();
    return seqs;
  }

  /**
   * Atomically replaces all of a session's events with a fresh set (deletes
   * then re-inserts, re-assigning `seq` from 0). For agents whose transcript
   * is re-read from scratch on every sync (Codex — see adapter-codex's
   * `syncCodexSessionFile`) rather than incrementally appended to.
   *
   * MUST NOT be called once a session has any hook-sourced event (see
   * `hasHookSourcedEvents`) — it would renumber `seq` out from under
   * `findings.from_seq`/`to_seq` evidence pointers and destroy hook data
   * that has no other record of itself. Once that's true, use `mergeEvents`
   * instead.
   */
  replaceEvents(sessionId: string, events: NewEvent[]): number[] {
    return this.transaction(() => {
      this.db.query('DELETE FROM events WHERE session_id = ?').run(sessionId);
      const insert = this.db.query(
        'INSERT INTO events (session_id, seq, ts, kind, payload, source, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      const seqs: number[] = [];
      let seq = 0;
      for (const e of events) {
        insert.run(
          sessionId,
          seq,
          e.ts,
          e.kind,
          JSON.stringify(e.payload),
          'transcript',
          fingerprintEvent(e),
        );
        seqs.push(seq);
        seq += 1;
      }
      return seqs;
    });
  }

  /**
   * Marks a session as hook-backed (see `migrateSessionHookBackedColumn`).
   * Idempotent — call on every hook output applied for a session, not just
   * the first. Once true, transcript sync must switch to `mergeEvents`
   * permanently for this session — never `replaceEvents`, never idle-based
   * finalize/reopen — even though `sessions.source` (set once, at creation)
   * may still say `'transcript'` if the session was originally opened
   * before any hook fired.
   */
  markSessionHookBacked(sessionId: string): void {
    this.db.query('UPDATE sessions SET hook_backed = 1 WHERE id = ?').run(sessionId);
  }

  isSessionHookBacked(sessionId: string): boolean {
    const row = this.db.query('SELECT hook_backed FROM sessions WHERE id = ?').get(sessionId) as
      | { hook_backed: number }
      | undefined;
    return row?.hook_backed === 1;
  }

  /**
   * Merges transcript-derived events into a session that may already have
   * hook-sourced rows — never deletes or renumbers existing rows. Each
   * event is matched by `fingerprintEvent`: a match already owned by
   * `'hooks'` is left untouched (hook data is authoritative), a match owned
   * by `'transcript'` is refreshed in place (idempotent re-sync of a still-
   * growing transcript), and no match inserts a new gap-fill row with a
   * fresh `seq`.
   *
   * One narrow exception, scoped to `agent_turn`: if this transcript
   * event's text is a non-empty strict prefix extension of an existing
   * hook-owned `agent_turn` in the same or an adjacent 30s bucket, that
   * row's text is completed in place (kept `seq`/`source`/`dedupe_key`) —
   * Codex's `Stop` hook payload truncates `last_assistant_message`, and the
   * transcript carries the full text. This only ever *extends* content the
   * hook already reported, never replaces it with something different.
   *
   * The fallback content+bucket fingerprint (see `fingerprintEvent`) isn't
   * DB-unique, so real repeats can share one key (a loop, or partial hook
   * coverage of a burst of identical messages). Matching is therefore
   * occurrence-accounted, not a single boolean check: existing rows for a
   * key are snapshotted once (in `seq` order) before this batch starts, and
   * each transcript occurrence of that key consumes one, in order. Once a
   * key's existing rows are exhausted, further occurrences in this same
   * transcript are genuinely new — hooks didn't capture all of them — and
   * become gap-fill inserts rather than being silently treated as "already
   * represented." The snapshot is taken once per key (not re-queried after
   * each insert) so this batch's own gap-fill inserts never satisfy a later
   * occurrence in the same call — each represents a distinct real event.
   */
  mergeEvents(sessionId: string, events: NewEvent[]): { inserted: number; enriched: number } {
    return this.transaction(() => {
      let inserted = 0;
      let enriched = 0;
      const existingByKey = new Map<string, { seq: number; source: EventSource }[]>();
      const consumedByKey = new Map<string, number>();

      for (const event of events) {
        const key = fingerprintEvent(event);
        if (key !== null) {
          let rows = existingByKey.get(key);
          if (rows === undefined) {
            rows = this.db
              .query(
                'SELECT seq, source FROM events WHERE session_id = ? AND dedupe_key = ? ORDER BY seq ASC',
              )
              .all(sessionId, key) as { seq: number; source: EventSource }[];
            existingByKey.set(key, rows);
          }
          const consumed = consumedByKey.get(key) ?? 0;
          if (consumed < rows.length) {
            const match = rows[consumed] as { seq: number; source: EventSource };
            consumedByKey.set(key, consumed + 1);
            if (match.source === 'transcript') {
              this.db
                .query('UPDATE events SET ts = ?, payload = ? WHERE session_id = ? AND seq = ?')
                .run(event.ts, JSON.stringify(event.payload), sessionId, match.seq);
            }
            continue; // this occurrence is already represented (hooks-owned wins as-is, transcript-owned refreshed)
          }
        }
        if (event.kind === 'agent_turn' && this.tryEnrichAgentTurn(sessionId, event)) {
          enriched += 1;
          continue;
        }
        this.insertMergedEvent(sessionId, event, key);
        inserted += 1;
      }
      return { inserted, enriched };
    });
  }

  /**
   * Extends a hook-owned `agent_turn`'s truncated text in place when this
   * transcript event's text is a longer, strict-prefix-extending version of
   * it. Updates `dedupe_key` to match the row's new (full-text) content, not
   * just `payload` — otherwise the row keeps advertising its old, truncated
   * fingerprint, the next sync's exact-content match on the now-full text
   * finds nothing, and this same enrichment can't recognize its own past
   * work — producing a duplicate insert on every subsequent sync instead of
   * a one-time enrichment.
   */
  private tryEnrichAgentTurn(sessionId: string, event: NewEvent): boolean {
    const text = (event.payload as { text: string }).text;
    if (!text) return false;
    const targetBucket = eventTimeBucket(event.ts);
    const candidates = this.db
      .query(
        "SELECT seq, payload, ts FROM events WHERE session_id = ? AND kind = 'agent_turn' AND source = 'hooks'",
      )
      .all(sessionId) as { seq: number; payload: string; ts: number }[];
    for (const row of candidates) {
      if (Math.abs(eventTimeBucket(row.ts) - targetBucket) > 1) continue;
      const existingPayload = JSON.parse(row.payload) as { text: string };
      const existingText = existingPayload.text ?? '';
      if (existingText.length === 0 || text.length <= existingText.length) continue;
      if (!text.startsWith(existingText)) continue;
      const mergedPayload = { ...existingPayload, text };
      // Keyed on the incoming transcript event's `ts`, not the hook row's —
      // a future sync re-fingerprints this same transcript record with its
      // own (stable, unchanged-on-replay) `ts` every time. Since this
      // exception only fires when the two timestamps sit in the same or an
      // *adjacent* bucket, keying on the hook row's `ts` instead would mean
      // the two buckets disagree and a later sync's exact-match lookup
      // misses this row — recognizing it as its own past enrichment fails,
      // and it inserts a duplicate instead.
      const newKey = fingerprintEvent({ kind: 'agent_turn', ts: event.ts, payload: mergedPayload });
      this.db
        .query('UPDATE events SET payload = ?, dedupe_key = ? WHERE session_id = ? AND seq = ?')
        .run(JSON.stringify(mergedPayload), newKey, sessionId, row.seq);
      return true;
    }
    return false;
  }

  private insertMergedEvent(sessionId: string, event: NewEvent, dedupeKey: string | null): void {
    const nextSeqRow = this.db
      .query('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE session_id = ?')
      .get(sessionId) as { next: number };
    this.db
      .query(
        `INSERT INTO events (session_id, seq, ts, kind, payload, source, dedupe_key)
         VALUES (?, ?, ?, ?, ?, 'transcript', ?)
         ON CONFLICT(session_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND dedupe_key LIKE 'call:%' DO NOTHING`,
      )
      .run(
        sessionId,
        nextSeqRow.next,
        event.ts,
        event.kind,
        JSON.stringify(event.payload),
        dedupeKey,
      );
  }

  getEvents(
    sessionId: string,
    opts: { from?: number; to?: number; kinds?: string[] } = {},
  ): Event[] {
    let sql = 'SELECT * FROM events WHERE session_id = ?';
    const params: (string | number)[] = [sessionId];
    if (opts.from !== undefined) {
      sql += ' AND seq >= ?';
      params.push(opts.from);
    }
    if (opts.to !== undefined) {
      sql += ' AND seq <= ?';
      params.push(opts.to);
    }
    if (opts.kinds && opts.kinds.length > 0) {
      sql += ` AND kind IN (${opts.kinds.map(() => '?').join(',')})`;
      params.push(...opts.kinds);
    }
    sql += ' ORDER BY seq ASC';
    const rows = this.db.query(sql).all(...params) as Record<string, unknown>[];
    return rows.map(toEvent);
  }

  // --- findings ---

  /**
   * Deletes a session's still-open findings — call before re-running
   * analyzers over it (report re-run, a duplicate session_end hook) so
   * findings are *replaced*, not accumulated. Resolved findings are left
   * alone: a user's "I looked at this and it's fine" shouldn't be erased by
   * a later re-analysis.
   */
  deleteOpenFindings(sessionId: string): void {
    this.db
      .query('DELETE FROM findings WHERE session_id = ? AND resolved_at IS NULL')
      .run(sessionId);
  }

  createFinding(f: NewFinding): Finding {
    const id = ulid();
    const createdAt = Date.now();
    this.db
      .query(
        `INSERT INTO findings
          (id, session_id, analyzer, severity, title, explanation, from_seq, to_seq, data, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        f.sessionId,
        f.analyzer,
        f.severity,
        f.title,
        f.explanation,
        f.fromSeq,
        f.toSeq,
        f.data === null || f.data === undefined ? null : JSON.stringify(f.data),
        createdAt,
      );
    return this.getFinding(id) as Finding;
  }

  getFinding(id: string): Finding | null {
    const row = this.db.query('SELECT * FROM findings WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toFinding(row) : null;
  }

  listFindings(opts: { sessionId?: string; open?: boolean } = {}): Finding[] {
    let sql = 'SELECT * FROM findings WHERE 1=1';
    const params: string[] = [];
    if (opts.sessionId) {
      sql += ' AND session_id = ?';
      params.push(opts.sessionId);
    }
    if (opts.open) {
      sql += ' AND resolved_at IS NULL';
    }
    sql += ' ORDER BY created_at DESC';
    const rows = this.db.query(sql).all(...params) as Record<string, unknown>[];
    return rows.map(toFinding);
  }

  resolveFinding(id: string, resolvedAt: number = Date.now()): void {
    this.db.query('UPDATE findings SET resolved_at = ? WHERE id = ?').run(resolvedAt, id);
  }

  // --- briefs ---

  upsertBrief(brief: Brief): void {
    this.db
      .query(
        `INSERT INTO briefs (session_id, generated_at, markdown) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET generated_at = excluded.generated_at, markdown = excluded.markdown`,
      )
      .run(brief.sessionId, brief.generatedAt, brief.markdown);
  }

  getBrief(sessionId: string): Brief | null {
    const row = this.db.query('SELECT * FROM briefs WHERE session_id = ?').get(sessionId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return toBrief(row);
  }

  /**
   * The brief a session starting *now* should see — the most recently
   * generated brief in this repo, regardless of which past session it was
   * generated from. See brief.ts's note on why `briefs.session_id` can't be
   * "the next session" directly.
   */
  getLatestBrief(): Brief | null {
    const row = this.db.query('SELECT * FROM briefs ORDER BY generated_at DESC LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
    return row ? toBrief(row) : null;
  }
}

export function openRepoDb(path: string): RepoStore {
  return new RepoStore(path);
}
