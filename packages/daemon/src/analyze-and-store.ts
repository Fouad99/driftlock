import { DETERMINISTIC_ANALYZERS, deriveTask, runAnalyzers } from '@driftlock/analyzers';
import type { Logger, RepoStore } from '@driftlock/core';
import { buildGitContext, noopLogger } from '@driftlock/core';

/**
 * Runs the deterministic analyzers over a finished session and stores the
 * findings. *Replaces* the session's open findings rather than appending to
 * them — safe to call more than once for the same session (a duplicate
 * session_end hook, a manual re-analysis) without piling up duplicates.
 * Returns the new finding count.
 */
export async function analyzeAndStore(
  sessionId: string,
  repoRoot: string,
  repoDb: RepoStore,
  logger: Logger = noopLogger,
): Promise<number> {
  const session = repoDb.getSession(sessionId);
  if (!session) return 0;

  const events = repoDb.getEvents(sessionId);
  const task = deriveTask(session, events);
  const git = buildGitContext(repoRoot, session.headBefore, session.headAfter) ?? undefined;
  const previousFindings = repoDb
    .listFindings({ open: true })
    .filter((f) => f.sessionId !== sessionId);
  // For `resume_quality` — the repo's most recent session started before
  // this one, if any. `endedAt` is null both when there isn't one and when
  // that session never ended; either way there's no gap to measure.
  const [previousSession] = repoDb.listSessions({ before: session.startedAt, limit: 1 });
  const previousSessionEndedAt = previousSession?.endedAt ?? null;

  const newFindings = await runAnalyzers(
    DETERMINISTIC_ANALYZERS,
    {
      session,
      events,
      previousFindings,
      previousSessionEndedAt,
      ...(task && { task }),
      ...(git && { git }),
    },
    logger,
  );

  repoDb.transaction(() => {
    repoDb.deleteOpenFindings(sessionId);
    for (const f of newFindings) repoDb.createFinding(f);
  });

  return newFindings.length;
}
