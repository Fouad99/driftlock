import { randomUUID } from 'node:crypto';
import type { AgentId, HookEnvelope } from '@driftlock/core';

/** Builds the envelope from the raw stdin text; agent hooks send JSON, but nothing is ever dropped if they don't. */
export function buildEnvelope(
  agent: AgentId,
  event: string,
  cwd: string,
  stdinText: string,
): HookEnvelope {
  const trimmed = stdinText.trim();
  let payload: unknown = {};
  if (trimmed.length > 0) {
    try {
      payload = JSON.parse(trimmed);
    } catch {
      payload = { raw: trimmed };
    }
  }
  return { id: randomUUID(), agent, event, cwd, receivedAt: Date.now(), payload };
}
