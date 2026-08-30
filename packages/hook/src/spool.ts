import type { HookEnvelope } from '@driftlock/core';
import { openSpoolDb, spoolDbPath } from '@driftlock/core';

// Architecture doc §4.1/§10 — "If the daemon is unreachable, it appends the
// line to <driftlock-home>/spool[...] and exits 0 — the agent never sees a
// failure because of driftlock." Backed by SQLite (`spool.sqlite`), not raw
// JSONL files — see core/src/store/spool-db.ts for why.

export function appendToSpool(driftlockHomeDir: string, envelope: HookEnvelope): void {
  const db = openSpoolDb(spoolDbPath(driftlockHomeDir));
  try {
    db.enqueue(envelope);
  } finally {
    db.close();
  }
}
