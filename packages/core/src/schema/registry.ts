import { z } from 'zod';
import { AgentIdSchema } from './session.ts';

// Architecture doc §5.3 — machine-wide registry (~/.driftlock/registry.sqlite).

export const RepoSchema = z.object({
  repoId: z.string(),
  root: z.string(),
  name: z.string().nullable(),
  agents: z.array(AgentIdSchema),
  registeredAt: z.number().int(),
  lastSeen: z.number().int().nullable(),
});
export type Repo = z.infer<typeof RepoSchema>;

export const SessionIndexRowSchema = z.object({
  sessionId: z.string(),
  repoId: z.string(),
  agent: AgentIdSchema,
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  openFindings: z.number().int(),
});
export type SessionIndexRow = z.infer<typeof SessionIndexRowSchema>;
