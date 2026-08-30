import { AgentIdSchema } from '@driftlock/core';
import { z } from 'zod';

// Architecture doc §4.1 — the envelope the hook client wraps every payload
// in: `{id, agent, event, cwd, receivedAt, payload}`. (`payload` is typed
// `unknown` and zod treats an unknown-typed key as structurally optional, so
// this can't be pinned to core's `HookEnvelope` via `satisfies` — the shape
// still matches; a missing `payload` key just parses as `undefined`.)
export const HookEnvelopeSchema = z.object({
  id: z.string(),
  agent: AgentIdSchema,
  event: z.string(),
  cwd: z.string(),
  receivedAt: z.number(),
  payload: z.unknown(),
});

export type ValidatedHookEnvelope = z.infer<typeof HookEnvelopeSchema>;
