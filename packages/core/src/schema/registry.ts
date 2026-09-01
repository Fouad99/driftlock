import { z } from 'zod';
import { AgentIdSchema } from './session.ts';

// Architecture doc §5.3 — machine-wide registry (~/.driftlock/registry.sqlite).

// M3: `branch`/`gitStatus`/`gitCheckedAt` are the cached git-state columns
// the Overview screen reads instead of probing git per request (05-UI.md
// §2.1) — refreshed by `syncSessionIndex`, never by a request handler.
export const RepoSchema = z.object({
  repoId: z.string(),
  root: z.string(),
  name: z.string().nullable(),
  agents: z.array(AgentIdSchema),
  registeredAt: z.number().int(),
  lastSeen: z.number().int().nullable(),
  branch: z.string().nullable(),
  gitStatus: z.enum(['clean', 'dirty', 'unavailable']),
  gitCheckedAt: z.number().int().nullable(),
});
export type Repo = z.infer<typeof RepoSchema>;

// M3: per-severity open counts (`openFindingsBySeverity`) alongside the
// existing `openFindings` total — Overview needs the breakdown, not just
// the sum (05-UI.md §2.1).
export const SessionIndexRowSchema = z.object({
  sessionId: z.string(),
  repoId: z.string(),
  agent: AgentIdSchema,
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  openFindings: z.number().int(),
  openFindingsBySeverity: z.object({
    info: z.number().int(),
    warn: z.number().int(),
    high: z.number().int(),
  }),
});
export type SessionIndexRow = z.infer<typeof SessionIndexRowSchema>;
