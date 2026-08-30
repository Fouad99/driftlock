import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { HookEnvelope } from '../interfaces/adapter.ts';

// `<driftlock-home>/spool.sqlite` — replaces the earlier `spool/<agent>.jsonl`
// file-based queue. That design had a real race: the daemon's drain read the
// whole file then overwrote/deleted the same path, while the hook client
// appended to it concurrently — a line written mid-drain could be silently
// destroyed. SQLite (already the backbone of this project) gives real
// atomicity for free: each envelope is its own row, enqueued with one INSERT
// and removed with one DELETE after it's applied; concurrent writers never
// collide.

export function spoolDbPath(driftlockHomeDir: string): string {
  return join(driftlockHomeDir, 'spool.sqlite');
}

export interface SpoolEntry {
  id: number;
  envelope: unknown; // validate with HookEnvelopeSchema before trusting the shape
}

export class SpoolStore {
  readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS spool (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        envelope TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );`,
    );
  }

  enqueue(envelope: HookEnvelope): void {
    this.db
      .query('INSERT INTO spool (envelope, created_at) VALUES (?, ?)')
      .run(JSON.stringify(envelope), Date.now());
  }

  /**
   * Oldest first, so replayed hooks apply in the order they originally
   * fired. `afterId` pages through a backlog larger than `limit` — pass the
   * last id seen from the previous batch (not the count processed: a failed
   * entry stays in the table but the cursor still advances past it, so one
   * batch of transient failures can't make the drain loop re-fetch the same
   * entries forever).
   */
  listPending(limit = 1000, afterId = 0): SpoolEntry[] {
    const rows = this.db
      .query('SELECT id, envelope FROM spool WHERE id > ? ORDER BY id ASC LIMIT ?')
      .all(afterId, limit) as {
      id: number;
      envelope: string;
    }[];
    return rows.map((r) => ({ id: r.id, envelope: JSON.parse(r.envelope) }));
  }

  remove(id: number): void {
    this.db.query('DELETE FROM spool WHERE id = ?').run(id);
  }

  count(): number {
    const row = this.db.query('SELECT COUNT(*) AS n FROM spool').get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

export function openSpoolDb(path: string): SpoolStore {
  return new SpoolStore(path);
}
