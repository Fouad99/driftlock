import { z } from 'zod';

// Architecture doc §5.1 — briefs table.
//
// `sessionId` is the *source* session — the one that just ended and the
// brief was generated from — not the (not-yet-existing) next session the
// brief is meant for. A brief can't key on the next session's id at
// generation time because that session doesn't exist yet. Consumers that
// want "the brief for whatever session starts next" use
// `RepoStore.getLatestBrief()`, which is repo-scoped (one per-repo db, so no
// `repo_id` column is needed) and orders by `generatedAt` — see M2's
// resume-brief lookup-model decision.

export const BriefSchema = z.object({
  sessionId: z.string(),
  generatedAt: z.number().int(),
  markdown: z.string(),
});
export type Brief = z.infer<typeof BriefSchema>;
