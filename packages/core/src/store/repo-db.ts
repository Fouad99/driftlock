import { Database } from 'bun:sqlite';
import { monotonicFactory } from 'ulid';
import type { Brief } from '../schema/brief.ts';
import type { Event, NewEvent } from '../schema/event.ts';
import type { Finding, NewFinding } from '../schema/finding.ts';
import type { Session, SessionInit } from '../schema/session.ts';
import { REPO_DB_MIGRATIONS } from './migrations.ts';

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
      const existing = this.getMeta('schema_version');
      if (existing === null) {
        this.setMeta('schema_version', SCHEMA_VERSION);
      }
    })();
  }

  close(): void {
    this.db.close();
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

  endSession(id: string, endedAt: number, reason: string, headAfter?: string | null): void {
    this.db
      .query(
        'UPDATE sessions SET ended_at = ?, end_reason = ?, head_after = COALESCE(?, head_after) WHERE id = ?',
      )
      .run(endedAt, reason, headAfter ?? null, id);
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

  /** Appends events, assigning a monotonic `seq` per session. Returns the assigned seqs. */
  appendEvents(sessionId: string, events: NewEvent[]): number[] {
    const nextSeqRow = this.db
      .query('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE session_id = ?')
      .get(sessionId) as { next: number };
    let seq = nextSeqRow.next;
    const insert = this.db.query(
      'INSERT INTO events (session_id, seq, ts, kind, payload) VALUES (?, ?, ?, ?, ?)',
    );
    const seqs: number[] = [];
    this.db.transaction(() => {
      for (const e of events) {
        insert.run(sessionId, seq, e.ts, e.kind, JSON.stringify(e.payload));
        seqs.push(seq);
        seq += 1;
      }
    })();
    return seqs;
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
    return {
      sessionId: row.session_id as string,
      generatedAt: row.generated_at as number,
      markdown: row.markdown as string,
    };
  }
}

export function openRepoDb(path: string): RepoStore {
  return new RepoStore(path);
}
