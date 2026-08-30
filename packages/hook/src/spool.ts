import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HookEnvelope } from '@driftlock/core';

// Architecture doc §4.1/§10 — "If the daemon is unreachable, it appends the
// line to <driftlock-home>/spool/<agent>.jsonl and exits 0 — the agent never
// sees a failure because of driftlock."

export function spoolPath(driftlockHomeDir: string, agent: HookEnvelope['agent']): string {
  return join(driftlockHomeDir, 'spool', `${agent}.jsonl`);
}

export function appendToSpool(driftlockHomeDir: string, envelope: HookEnvelope): void {
  mkdirSync(join(driftlockHomeDir, 'spool'), { recursive: true });
  appendFileSync(spoolPath(driftlockHomeDir, envelope.agent), `${JSON.stringify(envelope)}\n`);
}
