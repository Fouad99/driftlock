import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentId } from '@driftlock/core';
import { currentBranch, driftlockHome, isDirty, openRegistryDb } from '@driftlock/core';

// Usage doc — `driftlock status`: "One line per registered repo: name, last
// session, agent, open findings, dirty branch." Reads the registry's
// `session_index` (denormalized so this never opens a repo db — architecture
// doc §5.3/§9), falling back to an empty row for repos that have no sessions
// indexed yet (e.g. just `init`'d, nothing run there).

export interface StatusRow {
  repoId: string;
  name: string;
  root: string;
  lastSessionAt: number | null;
  agent: AgentId | null;
  openFindings: number;
  branch: string | null;
  dirty: boolean;
}

export async function runStatus(): Promise<StatusRow[]> {
  const home = driftlockHome();
  mkdirSync(home, { recursive: true });
  const registryDb = openRegistryDb(join(home, 'registry.sqlite'));
  try {
    return registryDb.listRepos().map((repo) => {
      const sessions = registryDb.listSessionIndex(repo.repoId);
      const latest = sessions[0] ?? null;
      return {
        repoId: repo.repoId,
        name: repo.name ?? repo.root,
        root: repo.root,
        lastSessionAt: latest?.startedAt ?? null,
        agent: latest?.agent ?? null,
        openFindings: sessions.reduce((sum, s) => sum + s.openFindings, 0),
        branch: currentBranch(repo.root),
        dirty: isDirty(repo.root),
      };
    });
  } finally {
    registryDb.close();
  }
}
