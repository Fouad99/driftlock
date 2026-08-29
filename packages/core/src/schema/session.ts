import { z } from 'zod';

// Architecture doc §5.1 — sessions table.

export const AgentIdSchema = z.enum(['claude-code', 'cursor', 'codex']);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const SessionSourceSchema = z.enum(['hooks', 'transcript']);
export type SessionSource = z.infer<typeof SessionSourceSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  agent: AgentIdSchema,
  agentSession: z.string().nullable(),
  repoRoot: z.string(),
  branch: z.string().nullable(),
  headBefore: z.string().nullable(),
  headAfter: z.string().nullable(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  endReason: z.string().nullable(),
  taskText: z.string().nullable(),
  tokenIn: z.number().int().nullable(),
  tokenOut: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  source: SessionSourceSchema,
});
export type Session = z.infer<typeof SessionSchema>;

// What an adapter has on hand when it opens a session; the store assigns `id`.
export const SessionInitSchema = SessionSchema.omit({
  id: true,
  endedAt: true,
  endReason: true,
}).extend({
  id: z.string().optional(),
});
export type SessionInit = z.infer<typeof SessionInitSchema>;
