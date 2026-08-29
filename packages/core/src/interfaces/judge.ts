import type { z } from 'zod';

// Architecture doc §6.3 — Judge interface for LLM-backed analyzers (milestone 4).
// Implementations (AnthropicJudge, OllamaJudge) never see a whole transcript —
// only bounded slices built by the calling analyzer.

export interface JudgeRequest<T> {
  question: string;
  slice: string;
  schema: z.ZodType<T>;
}

export interface Judge {
  assess<T>(req: JudgeRequest<T>): Promise<T>;
}
