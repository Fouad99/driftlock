import { z } from 'zod';

// Architecture doc §5.1 — briefs table. Generator lands in M2; the table
// ships now so the migration surface doesn't change later.

export const BriefSchema = z.object({
  sessionId: z.string(), // the session the brief was generated *for* (the next one)
  generatedAt: z.number().int(),
  markdown: z.string(),
});
export type Brief = z.infer<typeof BriefSchema>;
