import type { Logger, Session } from '@driftlock/core';
import { findRepoRoot, noopLogger, openRepoDb, repoDbPath } from '@driftlock/core';

// Usage doc — `driftlock sessions [--repo] [--last N]`: "List sessions with
// duration, agent, findings count."

export interface SessionsOptions {
  cwd: string;
  repoRoot?: string;
  last?: number;
  logger?: Logger;
}

export interface SessionRow {
  session: Session;
  openFindings: number;
}

export async function runSessions(opts: SessionsOptions): Promise<SessionRow[]> {
  const logger = opts.logger ?? noopLogger;
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd);
  if (!repoRoot) throw new Error(`no git repository found at or above ${opts.cwd}`);

  const repoDb = openRepoDb(repoDbPath(repoRoot));
  try {
    const sessions = repoDb.listSessions({ limit: opts.last ?? 20 });
    logger.debug('listed sessions', { repoRoot, count: sessions.length });
    return sessions.map((session) => ({
      session,
      openFindings: repoDb.listFindings({ sessionId: session.id, open: true }).length,
    }));
  } finally {
    repoDb.close();
  }
}
