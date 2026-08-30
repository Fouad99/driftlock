import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger, SpoolStore } from '@driftlock/core';
import { noopLogger, openSpoolDb, spoolDbPath } from '@driftlock/core';
import { HookEnvelopeSchema, type ValidatedHookEnvelope } from './hook-envelope.ts';

// Architecture doc §4.1/§10 — the daemon drains the spool on startup.
// At-least-once: a row that fails to apply is left in place (not deleted)
// for the next drain rather than dropped. Each row is its own SQLite
// transaction-scoped delete after a successful apply, so a hook client
// enqueuing concurrently never collides with the drain (see spool-db.ts).

const DEFAULT_BATCH_SIZE = 1000;

export interface DrainResult {
  processed: number;
  failed: number;
}

/**
 * Migrates any leftover pre-SQLite spool files (`<home>/spool/<agent>.jsonl`,
 * one JSON envelope per line — the format used before the spool moved to
 * `spool.sqlite`) into the SQLite spool, so envelopes queued by an older
 * driftlock version aren't silently dropped on upgrade. Each line is parsed
 * individually — a malformed line is logged and skipped rather than failing
 * the whole file — and a line missing `id` (pre-idempotency-key envelopes)
 * gets one synthesized, since replay-safety only matters going forward.
 * Called once at the start of `drainSpool`, before the migrated entries are
 * themselves paged through in the same pass. Each file is deleted only after
 * every line in it has been handled, so a crash mid-migration just re-reads
 * the same file (and re-enqueues already-migrated lines as harmless
 * duplicates — normal spool at-least-once semantics) rather than losing it.
 */
function migrateLegacySpoolFiles(driftlockHomeDir: string, db: SpoolStore, logger: Logger): void {
  const spoolDir = join(driftlockHomeDir, 'spool');
  if (!existsSync(spoolDir)) return;

  let entries: string[];
  try {
    entries = readdirSync(spoolDir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return;
  }

  for (const name of entries) {
    const path = join(spoolDir, name);
    let lines: string[];
    try {
      lines = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0);
    } catch (err) {
      logger.warn('could not read legacy spool file, leaving it in place', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let migrated = 0;
    let dropped = 0;
    for (const line of lines) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(line);
      } catch {
        dropped += 1;
        continue;
      }
      const withId =
        parsedJson && typeof parsedJson === 'object' && !('id' in parsedJson)
          ? { ...parsedJson, id: crypto.randomUUID() }
          : parsedJson;
      const parsed = HookEnvelopeSchema.safeParse(withId);
      if (!parsed.success) {
        dropped += 1;
        continue;
      }
      // Explicit literal (not a spread) so `payload` is always a present
      // key, matching core's `HookEnvelope` regardless of zod's optionality
      // quirk for `unknown`-typed fields (see hook-envelope.ts).
      db.enqueue({
        id: parsed.data.id,
        agent: parsed.data.agent,
        event: parsed.data.event,
        cwd: parsed.data.cwd,
        receivedAt: parsed.data.receivedAt,
        payload: parsed.data.payload,
      });
      migrated += 1;
    }

    logger.info('migrated legacy JSONL spool file into spool.sqlite', {
      path,
      migrated,
      dropped,
    });
    rmSync(path, { force: true });
  }
}

export async function drainSpool(
  driftlockHomeDir: string,
  handle: (envelope: ValidatedHookEnvelope) => Promise<unknown>,
  logger: Logger = noopLogger,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<DrainResult> {
  const db = openSpoolDb(spoolDbPath(driftlockHomeDir));
  let processed = 0;
  let failed = 0;

  try {
    migrateLegacySpoolFiles(driftlockHomeDir, db, logger);

    // Paged so a backlog bigger than one batch is fully drained in this
    // single call, not left for another daemon restart — the cursor
    // (`afterId`) advances past every entry seen, including ones that
    // failed and were left in place, so a batch of transient failures can't
    // turn this into an infinite loop re-fetching the same rows.
    let afterId = 0;
    for (;;) {
      const batch = db.listPending(batchSize, afterId);
      if (batch.length === 0) break;

      for (const entry of batch) {
        afterId = entry.id;
        const parsed = HookEnvelopeSchema.safeParse(entry.envelope);
        if (!parsed.success) {
          failed += 1;
          db.remove(entry.id); // malformed row: drop rather than retry forever
          logger.warn('dropped malformed spool entry', { id: entry.id });
          continue;
        }
        try {
          await handle(parsed.data);
          db.remove(entry.id);
          processed += 1;
        } catch (err) {
          failed += 1; // transient failure: leave the row for the next drain
          logger.error('spool entry failed to apply, will retry next drain', {
            id: entry.id,
            agent: parsed.data.agent,
            event: parsed.data.event,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  } finally {
    db.close();
  }

  if (processed > 0 || failed > 0) {
    logger.info('spool drain complete', { processed, failed });
  }

  return { processed, failed };
}
