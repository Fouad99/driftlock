import type { CommitDetail } from '@driftlock/core';
import { findRepoRoot } from '@driftlock/core';
import { getCommitDetail } from '@driftlock/daemon';

// CLI counterpart to `GET /api/repos/:id/commits/:sha` (05-UI.md §4.2) —
// both call `getCommitDetail` so the two never diverge.

export interface CommitShowOptions {
  cwd: string;
  sha: string;
}

export function runCommitShow(opts: CommitShowOptions): CommitDetail {
  const repoRoot = findRepoRoot(opts.cwd);
  if (!repoRoot) throw new Error(`no git repository found at or above ${opts.cwd}`);
  const commit = getCommitDetail(repoRoot, opts.sha);
  if (!commit) throw new Error(`commit ${opts.sha} not found (or not a valid sha)`);
  return commit;
}
