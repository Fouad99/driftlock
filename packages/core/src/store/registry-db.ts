import { Database } from 'bun:sqlite';
import type { Repo, SessionIndexRow } from '../schema/registry.ts';
import type { AgentId } from '../schema/session.ts';
import { REGISTRY_DB_MIGRATIONS } from './migrations.ts';

function toRepo(row: Record<string, unknown>): Repo {
  return {
    repoId: row.repo_id as string,
    root: row.root as string,
    name: (row.name as string | null) ?? null,
    agents: JSON.parse(row.agents as string) as AgentId[],
    registeredAt: row.registered_at as number,
    lastSeen: (row.last_seen as number | null) ?? null,
  };
}

function toSessionIndexRow(row: Record<string, unknown>): SessionIndexRow {
  return {
    sessionId: row.session_id as string,
    repoId: row.repo_id as string,
    agent: row.agent as AgentId,
    startedAt: row.started_at as number,
    endedAt: (row.ended_at as number | null) ?? null,
    openFindings: row.open_findings as number,
  };
}

export class RegistryStore {
  readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.transaction(() => {
      for (const stmt of REGISTRY_DB_MIGRATIONS) {
        this.db.exec(stmt);
      }
    })();
  }

  close(): void {
    this.db.close();
  }

  // --- repos ---

  upsertRepo(repo: Repo): void {
    this.db
      .query(
        `INSERT INTO repos (repo_id, root, name, agents, registered_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET
           root = excluded.root, name = excluded.name, agents = excluded.agents,
           last_seen = excluded.last_seen`,
      )
      .run(
        repo.repoId,
        repo.root,
        repo.name,
        JSON.stringify(repo.agents),
        repo.registeredAt,
        repo.lastSeen,
      );
  }

  getRepo(repoId: string): Repo | null {
    const row = this.db.query('SELECT * FROM repos WHERE repo_id = ?').get(repoId) as
      | Record<string, unknown>
      | undefined;
    return row ? toRepo(row) : null;
  }

  getRepoByRoot(root: string): Repo | null {
    const row = this.db.query('SELECT * FROM repos WHERE root = ?').get(root) as
      | Record<string, unknown>
      | undefined;
    return row ? toRepo(row) : null;
  }

  listRepos(): Repo[] {
    const rows = this.db.query('SELECT * FROM repos ORDER BY last_seen DESC').all() as Record<
      string,
      unknown
    >[];
    return rows.map(toRepo);
  }

  // --- session_index ---

  upsertSessionIndex(row: SessionIndexRow): void {
    this.db
      .query(
        `INSERT INTO session_index (session_id, repo_id, agent, started_at, ended_at, open_findings)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           ended_at = excluded.ended_at, open_findings = excluded.open_findings`,
      )
      .run(row.sessionId, row.repoId, row.agent, row.startedAt, row.endedAt, row.openFindings);
  }

  listSessionIndex(repoId?: string): SessionIndexRow[] {
    const rows = (
      repoId
        ? this.db
            .query('SELECT * FROM session_index WHERE repo_id = ? ORDER BY started_at DESC')
            .all(repoId)
        : this.db.query('SELECT * FROM session_index ORDER BY started_at DESC').all()
    ) as Record<string, unknown>[];
    return rows.map(toSessionIndexRow);
  }

  // --- daemon_state ---

  getDaemonState(key: string): string | null {
    const row = this.db.query('SELECT value FROM daemon_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setDaemonState(key: string, value: string): void {
    this.db
      .query(
        'INSERT INTO daemon_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }
}

export function openRegistryDb(path: string): RegistryStore {
  return new RegistryStore(path);
}
