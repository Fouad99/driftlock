import { z } from 'zod';

// Architecture doc §4.4 — TaskSource interface. v1 source is transcript-derived
// (first user prompt + plan items); issue trackers are later plugins.

export const TaskSchema = z.object({
  text: z.string(),
  source: z.enum(['transcript', 'plugin']),
  ref: z.string().optional(), // e.g. issue id, when a plugin source is used
});
export type Task = z.infer<typeof TaskSchema>;
