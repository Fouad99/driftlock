import { join } from 'node:path';
import type { Finding } from '@driftlock/core';
import {
  driftlockHome,
  findRepoRoot,
  openRegistryDb,
  openRepoDb,
  readRepoMeta,
  repoDbPath,
} from '@driftlock/core';
import { resolveFindingMutation } from '@driftlock/daemon';
import { type DaemonConnection, findRunningDaemon } from './daemon-client.ts';

// CLI counterpart to `POST /api/repos/:id/findings/:fid/resolve` (05-UI.md
// §4.2). Routes through a running daemon when one is reachable (so the
// mutation is visible over SSE — see `daemon-client.ts`), otherwise both
// paths still end up calling the same `resolveFindingMutation`.

export interface ResolveOptions {
  cwd: string;
  findingId: string;
}

export async function runResolve(opts: ResolveOptions): Promise<Finding> {
  const repoRoot = findRepoRoot(opts.cwd);
  if (!repoRoot) throw new Error(`no git repository found at or above ${opts.cwd}`);
  const repoId = readRepoMeta(repoRoot)?.repoId;
  if (!repoId) throw new Error('repo not registered — run `driftlock init` first');

  const daemon = await findRunningDaemon();
  if (daemon) return resolveViaDaemon(daemon, repoId, opts.findingId);
  return resolveDirect(repoRoot, repoId, opts.findingId);
}

async function resolveViaDaemon(
  daemon: DaemonConnection,
  repoId: string,
  findingId: string,
): Promise<Finding> {
  const res = await fetch(`${daemon.baseUrl}/api/repos/${repoId}/findings/${findingId}/resolve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  if (res.status === 404) throw new Error(`no finding ${findingId} found`);
  if (!res.ok) throw new Error(`daemon returned ${res.status} resolving finding ${findingId}`);
  return (await res.json()) as Finding;
}

function resolveDirect(repoRoot: string, repoId: string, findingId: string): Finding {
  const repoDb = openRepoDb(repoDbPath(repoRoot));
  const registryDb = openRegistryDb(join(driftlockHome(), 'registry.sqlite'));
  try {
    const finding = resolveFindingMutation(repoDb, registryDb, repoId, findingId);
    if (!finding) throw new Error(`no finding ${findingId} found`);
    return finding;
  } finally {
    repoDb.close();
    registryDb.close();
  }
}
