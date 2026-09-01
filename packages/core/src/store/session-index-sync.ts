import { currentBranch, gitStatus } from '../git.ts';
import type { RegistryStore } from './registry-db.ts';
import type { RepoStore } from './repo-db.ts';

// Architecture doc §5.3 — `session_index` is "denormalized for `status`
// without opening every repo db". Every write path that creates, ends, or
// adds findings to a session should call this so the registry stays fresh.
// M3 (05-UI.md §2.1): also the single choke point that refreshes the
// Overview's cached severity breakdown and git state, so every writer that
// already calls this (hook handler, transcript watcher, `driftlock report`)
// keeps the registry fresh for free — no request handler ever probes git or
// counts findings live.
export function syncSessionIndex(
  registryDb: RegistryStore,
  repoDb: RepoStore,
  repoId: string,
  sessionId: string,
): void {
  const session = repoDb.getSession(sessionId);
  if (!session) return;
  const bySeverity = repoDb.countOpenFindingsBySeverity(sessionId);
  const openFindings = bySeverity.info + bySeverity.warn + bySeverity.high;
  registryDb.upsertSessionIndex({
    sessionId,
    repoId,
    agent: session.agent,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    openFindings,
    openFindingsBySeverity: bySeverity,
  });
  refreshRepoGitState(registryDb, repoId, session.repoRoot);
}

/** Refreshes a repo's cached git-state columns from disk. Exported separately from `syncSessionIndex` so a mutation with no session in hand (e.g. resolving a finding) can still refresh it. */
export function refreshRepoGitState(
  registryDb: RegistryStore,
  repoId: string,
  repoRoot: string,
): void {
  const repo = registryDb.getRepo(repoId);
  if (!repo) return;
  registryDb.updateRepoGitState(repoId, {
    branch: currentBranch(repoRoot),
    gitStatus: gitStatus(repoRoot),
    gitCheckedAt: Date.now(),
  });
}
