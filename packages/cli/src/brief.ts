import type { Brief, Logger } from '@driftlock/core';
import { findRepoRoot, noopLogger, openRepoDb, repoDbPath } from '@driftlock/core';
import { type WriteResumeBlockResult, writeResumeBriefToRepo } from '@driftlock/daemon';

// Usage doc — `driftlock brief [--write]`: "Print the resume brief for cwd
// repo; --write updates the fenced blocks." The daemon already writes the
// fenced blocks automatically at every session end (generate-brief.ts) —
// `--write` re-runs just that write from whatever brief is already stored,
// for after a manual `DECISIONS.md` edit or before a session with no daemon
// running.

export interface BriefOptions {
  cwd: string;
  repoRoot?: string;
  write?: boolean;
  logger?: Logger;
}

export interface BriefResult {
  repoRoot: string;
  brief: Brief | null;
  written?: WriteResumeBlockResult[];
}

export async function runBrief(opts: BriefOptions): Promise<BriefResult> {
  const logger = opts.logger ?? noopLogger;
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd);
  if (!repoRoot) throw new Error(`no git repository found at or above ${opts.cwd}`);

  const repoDb = openRepoDb(repoDbPath(repoRoot));
  try {
    const brief = repoDb.getLatestBrief();
    logger.debug('read latest brief', { repoRoot, found: brief !== null });
    if (!opts.write || !brief) return { repoRoot, brief };
    const written = writeResumeBriefToRepo(repoRoot, brief.markdown);
    logger.debug('wrote fenced resume blocks', { paths: written.map((w) => w.path) });
    return { repoRoot, brief, written };
  } finally {
    repoDb.close();
  }
}
