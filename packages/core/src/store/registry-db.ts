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
    branch: (row.branch as string | null) ?? null,
    gitStatus: (row.git_status as Repo['gitStatus']) ?? 'unavailable',
    gitCheckedAt: (row.git_checked_at as number | null) ?? null,
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
    openFindingsBySeverity: {
      info: (row.open_findings_info as number | null) ?? 0,
      warn: (row.open_findings_warn as number | null) ?? 0,
      high: (row.open_findings_high as number | null) ?? 0,
    },
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
      this.migrateDenormalizedColumns();
    })();
  }

  /** Adds M3's denormalized Overview columns (05-UI.md §2.1) on top of the base migration, for registries created before they existed. */
  private migrateDenormalizedColumns(): void {
    const repoCols = this.db.query('PRAGMA table_info(repos)').all() as { name: string }[];
    const repoNames = new Set(repoCols.map((c) => c.name));
    if (!repoNames.has('branch')) this.db.exec('ALTER TABLE repos ADD COLUMN branch TEXT');
    if (!repoNames.has('git_status')) {
      this.db.exec("ALTER TABLE repos ADD COLUMN git_status TEXT NOT NULL DEFAULT 'unavailable'");
    }
    if (!repoNames.has('git_checked_at')) {
      this.db.exec('ALTER TABLE repos ADD COLUMN git_checked_at INTEGER');
    }

    const sessionCols = this.db.query('PRAGMA table_info(session_index)').all() as {
      name: string;
    }[];
    const sessionNames = new Set(sessionCols.map((c) => c.name));
    for (const col of ['open_findings_info', 'open_findings_warn', 'open_findings_high']) {
      if (!sessionNames.has(col)) {
        this.db.exec(`ALTER TABLE session_index ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // --- repos ---

  /**
   * `branch`/`gitStatus`/`gitCheckedAt` are optional on the way in — most
   * callers registering or touching a repo (`init`, hook-handler's
   * `lastSeen` bump) have no fresh git read in hand and aren't the ones
   * responsible for it; `syncSessionIndex`'s `updateRepoGitState` owns
   * keeping them current. Omitted fields default to "not probed yet"
   * (`gitStatus: 'unavailable'`) rather than requiring every caller to
   * either carry a value or fail a NOT NULL constraint.
   */
  upsertRepo(
    repo: Omit<Repo, 'branch' | 'gitStatus' | 'gitCheckedAt'> &
      Partial<Pick<Repo, 'branch' | 'gitStatus' | 'gitCheckedAt'>>,
  ): void {
    this.db
      .query(
        `INSERT INTO repos (repo_id, root, name, agents, registered_at, last_seen, branch, git_status, git_checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET
           root = excluded.root, name = excluded.name, agents = excluded.agents,
           last_seen = excluded.last_seen, branch = excluded.branch,
           git_status = excluded.git_status, git_checked_at = excluded.git_checked_at`,
      )
      .run(
        repo.repoId,
        repo.root,
        repo.name,
        JSON.stringify(repo.agents),
        repo.registeredAt,
        repo.lastSeen,
        repo.branch ?? null,
        repo.gitStatus ?? 'unavailable',
        repo.gitCheckedAt ?? null,
      );
  }

  /**
   * Refreshes just the cached git-state columns without touching identity
   * fields — the Overview screen reads these instead of probing git per
   * request (05-UI.md §2.1); called from `syncSessionIndex`, never from a
   * request handler.
   */
  updateRepoGitState(
    repoId: string,
    state: { branch: string | null; gitStatus: Repo['gitStatus']; gitCheckedAt: number },
  ): void {
    this.db
      .query('UPDATE repos SET branch = ?, git_status = ?, git_checked_at = ? WHERE repo_id = ?')
      .run(state.branch, state.gitStatus, state.gitCheckedAt, repoId);
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

  /** `openFindingsBySeverity` is optional on the way in (see `upsertRepo`'s note on the same pattern) — defaults to all-zero when a caller only has the total. */
  upsertSessionIndex(
    row: Omit<SessionIndexRow, 'openFindingsBySeverity'> &
      Partial<Pick<SessionIndexRow, 'openFindingsBySeverity'>>,
  ): void {
    const bySeverity = row.openFindingsBySeverity ?? { info: 0, warn: 0, high: 0 };
    this.db
      .query(
        `INSERT INTO session_index
          (session_id, repo_id, agent, started_at, ended_at, open_findings,
           open_findings_info, open_findings_warn, open_findings_high)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           ended_at = excluded.ended_at, open_findings = excluded.open_findings,
           open_findings_info = excluded.open_findings_info,
           open_findings_warn = excluded.open_findings_warn,
           open_findings_high = excluded.open_findings_high`,
      )
      .run(
        row.sessionId,
        row.repoId,
        row.agent,
        row.startedAt,
        row.endedAt,
        row.openFindings,
        bySeverity.info,
        bySeverity.warn,
        bySeverity.high,
      );
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

  /** Most recently started session for a repo — Overview's row → latest-session navigation (05-UI.md §2.1), a query-time `MAX(started_at)` over the small, indexed `session_index` rather than a stored column. */
  getLatestSessionIndex(repoId: string): SessionIndexRow | null {
    const row = this.db
      .query('SELECT * FROM session_index WHERE repo_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(repoId) as Record<string, unknown> | undefined;
    return row ? toSessionIndexRow(row) : null;
  }

  /**
   * 14 zero-filled daily buckets of open-findings-at-sessions-started-that-day,
   * oldest first — Overview's sparkline (05-UI.md §2.1). Bucketed by the
   * *session's* `startedAt` day (a live aggregate over `session_index`,
   * already denormalized and small/indexed per repo) rather than
   * `findings.created_at`, so this never opens a repo db. Because it sums
   * each session's *current* open-findings count rather than a historical
   * finding-creation count, resolving a finding lowers its day's bar
   * retroactively — an accepted simplification (05-UI.md §2.1), not a
   * point-in-time history.
   */
  getFindingSparkline(repoId: string, days = 14): { day: string; count: number }[] {
    const rows = this.db
      .query(
        `SELECT date(started_at / 1000, 'unixepoch') AS day, SUM(open_findings) AS count
         FROM session_index
         WHERE repo_id = ? AND started_at >= ?
         GROUP BY day`,
      )
      .all(repoId, Date.now() - days * 24 * 60 * 60 * 1000) as { day: string; count: number }[];
    const byDay = new Map(rows.map((r) => [r.day, r.count]));
    const buckets: { day: string; count: number }[] = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      buckets.push({ day: d, count: byDay.get(d) ?? 0 });
    }
    return buckets;
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
