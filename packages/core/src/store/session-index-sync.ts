import type { RegistryStore } from './registry-db.ts';
import type { RepoStore } from './repo-db.ts';

// Architecture doc §5.3 — `session_index` is "denormalized for `status`
// without opening every repo db". Every write path that creates, ends, or
// adds findings to a session should call this so the registry stays fresh.
export function syncSessionIndex(
  registryDb: RegistryStore,
  repoDb: RepoStore,
  repoId: string,
  sessionId: string,
): void {
  const session = repoDb.getSession(sessionId);
  if (!session) return;
  const openFindings = repoDb.listFindings({ sessionId, open: true }).length;
  registryDb.upsertSessionIndex({
    sessionId,
    repoId,
    agent: session.agent,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    openFindings,
  });
}
