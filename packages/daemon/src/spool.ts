import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@driftlock/core';
import { noopLogger } from '@driftlock/core';
import { HookEnvelopeSchema, type ValidatedHookEnvelope } from './hook-envelope.ts';

// Architecture doc §4.1/§10 — hook client appends to `<driftlock-home>/spool/<agent>.jsonl`
// when the daemon is unreachable; the daemon drains it on startup. At-least-once:
// a line that fails to process is kept for the next drain rather than dropped.

export function spoolDir(driftlockHomeDir: string): string {
  return join(driftlockHomeDir, 'spool');
}

export interface DrainResult {
  processed: number;
  failed: number;
}

export async function drainSpool(
  driftlockHomeDir: string,
  handle: (envelope: ValidatedHookEnvelope) => Promise<unknown>,
  logger: Logger = noopLogger,
): Promise<DrainResult> {
  const dir = spoolDir(driftlockHomeDir);
  if (!existsSync(dir)) return { processed: 0, failed: 0 };

  let processed = 0;
  let failed = 0;

  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const kept: string[] = [];

    for (const line of lines) {
      const parsed = (() => {
        try {
          return HookEnvelopeSchema.safeParse(JSON.parse(line));
        } catch {
          return { success: false as const };
        }
      })();
      if (!parsed.success) {
        failed += 1;
        logger.warn('dropped malformed spool line', { file: name });
        continue; // malformed line: drop rather than retry forever
      }
      try {
        await handle(parsed.data);
        processed += 1;
      } catch (err) {
        failed += 1;
        kept.push(line); // transient failure: keep for the next drain
        logger.error('spool line failed to apply, will retry next drain', {
          file: name,
          agent: parsed.data.agent,
          event: parsed.data.event,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (kept.length > 0) {
      writeFileSync(path, `${kept.join('\n')}\n`);
    } else {
      unlinkSync(path);
    }
  }

  if (processed > 0 || failed > 0) {
    logger.info('spool drain complete', { processed, failed });
  }

  return { processed, failed };
}
