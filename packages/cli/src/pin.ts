import type { Finding, Logger } from '@driftlock/core';
import { findRepoRoot, noopLogger, openRepoDb, readRepoMeta, repoDbPath } from '@driftlock/core';
import { setFindingPinnedMutation } from '@driftlock/daemon';
import { type DaemonConnection, findRunningDaemon } from './daemon-client.ts';

// CLI counterpart to `POST`/`DELETE /api/repos/:id/findings/:fid/brief`
// (05-UI.md §2.3/§4.2, "add to brief"). Routes through a running daemon
// when one is reachable (so the mutation is visible over SSE — see
// `daemon-client.ts`), otherwise both paths still end up calling the same
// `setFindingPinnedMutation`.

export interface PinOptions {
  cwd: string;
  findingId: string;
  pinned: boolean;
  logger?: Logger;
}

export async function runPin(opts: PinOptions): Promise<Finding> {
  const logger = opts.logger ?? noopLogger;
  const repoRoot = findRepoRoot(opts.cwd);
  if (!repoRoot) throw new Error(`no git repository found at or above ${opts.cwd}`);

  const daemon = await findRunningDaemon();
  if (daemon) {
    const repoId = readRepoMeta(repoRoot)?.repoId;
    if (repoId) return pinViaDaemon(daemon, repoId, opts.findingId, opts.pinned);
  }
  return pinDirect(repoRoot, opts.findingId, opts.pinned, logger);
}

async function pinViaDaemon(
  daemon: DaemonConnection,
  repoId: string,
  findingId: string,
  pinned: boolean,
): Promise<Finding> {
  const res = await fetch(`${daemon.baseUrl}/api/repos/${repoId}/findings/${findingId}/brief`, {
    method: pinned ? 'POST' : 'DELETE',
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  if (res.status === 404) throw new Error(`no finding ${findingId} found`);
  if (!res.ok) throw new Error(`daemon returned ${res.status} pinning finding ${findingId}`);
  return (await res.json()) as Finding;
}

async function pinDirect(
  repoRoot: string,
  findingId: string,
  pinned: boolean,
  logger: Logger,
): Promise<Finding> {
  const repoDb = openRepoDb(repoDbPath(repoRoot));
  try {
    const finding = await setFindingPinnedMutation(repoDb, repoRoot, findingId, pinned, logger);
    if (!finding) throw new Error(`no finding ${findingId} found`);
    return finding;
  } finally {
    repoDb.close();
  }
}
