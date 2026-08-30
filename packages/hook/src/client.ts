import type { AgentId, HookEnvelope } from '@driftlock/core';
import { readDaemonTarget } from './daemon-target.ts';
import { buildEnvelope } from './envelope.ts';
import { appendToSpool } from './spool.ts';

// Architecture doc §4.1 — "Latency budget: under 15 ms on the fire-and-forget
// path [...], under 300 ms worst case on the request-response path." We wait
// for the response either way (a loopback POST is sub-millisecond when the
// daemon is up; the budget is dominated by process start), but only
// request-response callers (SessionStart, PreToolUse) care about the body.
export const DEFAULT_TIMEOUT_MS = 300;

export interface RunHookClientOptions {
  agent: AgentId;
  event: string;
  cwd: string;
  driftlockHomeDir: string;
  stdinText: string;
  timeoutMs?: number;
}

export interface RunHookClientResult {
  delivered: boolean;
  responseBody?: unknown;
}

export async function runHookClient(opts: RunHookClientOptions): Promise<RunHookClientResult> {
  const envelope = buildEnvelope(opts.agent, opts.event, opts.cwd, opts.stdinText);
  const target = readDaemonTarget(opts.driftlockHomeDir);
  if (!target) {
    appendToSpool(opts.driftlockHomeDir, envelope);
    return { delivered: false };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const res = await fetch(`http://127.0.0.1:${target.port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      appendToSpool(opts.driftlockHomeDir, envelope);
      return { delivered: false };
    }
    const responseBody = await res.json().catch(() => undefined);
    return { delivered: true, responseBody };
  } catch {
    // Daemon down, port stale, or timed out — spool and let the agent proceed unaffected.
    appendToSpool(opts.driftlockHomeDir, envelope);
    return { delivered: false };
  }
}

export type { HookEnvelope };
