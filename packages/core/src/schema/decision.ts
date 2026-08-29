import { z } from 'zod';

// Architecture doc §7 — DECISIONS.md format. Parsed, never written, by driftlock.

export const DecisionSchema = z.object({
  id: z.string(), // 'D-001'
  title: z.string(),
  applies: z.array(z.string()), // globs; empty = applies everywhere
  since: z.string().nullable(),
  rationale: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;
