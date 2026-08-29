import { z } from 'zod';

// Architecture doc §5.1 — findings table.

export const SeveritySchema = z.enum(['info', 'warn', 'high']);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  analyzer: z.string(),
  severity: SeveritySchema,
  title: z.string(),
  explanation: z.string(),
  fromSeq: z.number().int().nullable(),
  toSeq: z.number().int().nullable(),
  data: z.unknown().nullable(),
  createdAt: z.number().int(),
  resolvedAt: z.number().int().nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const NewFindingSchema = FindingSchema.omit({ id: true, createdAt: true, resolvedAt: true });
export type NewFinding = z.infer<typeof NewFindingSchema>;
