import { DETERMINISTIC_ANALYZERS, runAnalyzers } from '@driftlock/analyzers';
import { type RepoStore, buildGitContext } from '@driftlock/core';

/** Runs the deterministic analyzers over a finished session and stores the findings. Returns the count. */
export async function analyzeAndStore(
  sessionId: string,
  repoRoot: string,
  repoDb: RepoStore,
): Promise<number> {
  const session = repoDb.getSession(sessionId);
  if (!session) return 0;

  const events = repoDb.getEvents(sessionId);
  const task = session.taskText
    ? { text: session.taskText, source: 'transcript' as const }
    : undefined;
  const git = buildGitContext(repoRoot, session.headBefore, session.headAfter) ?? undefined;
  const previousFindings = repoDb
    .listFindings({ open: true })
    .filter((f) => f.sessionId !== sessionId);

  const newFindings = await runAnalyzers(DETERMINISTIC_ANALYZERS, {
    session,
    events,
    previousFindings,
    ...(task && { task }),
    ...(git && { git }),
  });
  for (const f of newFindings) repoDb.createFinding(f);
  return newFindings.length;
}
