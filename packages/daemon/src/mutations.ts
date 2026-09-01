import type { Finding, Logger, RegistryStore, RepoStore } from '@driftlock/core';
import { noopLogger, syncSessionIndex } from '@driftlock/core';
import { generateBrief } from './generate-brief.ts';

// M3 (05-UI.md §4.2) — the single set of write functions behind both the
// `/api/*` routes and the CLI's `resolve`/`add-to-brief` commands. Every
// mutation here re-syncs `session_index` so the Overview's cached counts
// never go stale, and callers are expected to publish an SSE event after
// (see `bus.ts`) — that's the HTTP/CLI layer's job, not this one's, so this
// stays testable without a server.

/** Evidence pane's "mark resolved" (05-UI.md §2.3). */
export function resolveFindingMutation(
  repoDb: RepoStore,
  registryDb: RegistryStore,
  repoId: string,
  findingId: string,
): Finding | null {
  const finding = repoDb.getFinding(findingId);
  if (!finding) return null;
  repoDb.resolveFinding(findingId);
  syncSessionIndex(registryDb, repoDb, repoId, finding.sessionId);
  return repoDb.getFinding(findingId);
}

/**
 * Evidence pane's "add to brief" (05-UI.md §2.3) — pins/unpins a finding and
 * immediately regenerates the repo's current brief so the change is visible
 * without waiting for the next session end. Regenerates in place: the
 * existing latest brief's session id if one exists (so "regenerate" doesn't
 * silently reassign the brief to an unrelated session), otherwise the most
 * recently ended session. No-ops the regeneration (but still persists the
 * pin) if neither exists yet — `generateBrief` has nothing to attach to.
 */
export async function setFindingPinnedMutation(
  repoDb: RepoStore,
  repoRoot: string,
  findingId: string,
  pinned: boolean,
  logger: Logger = noopLogger,
): Promise<Finding | null> {
  const finding = repoDb.getFinding(findingId);
  if (!finding) return null;
  repoDb.setFindingPinned(findingId, pinned);
  const sessionId = regenTargetSessionId(repoDb);
  if (sessionId) await generateBrief(sessionId, repoRoot, repoDb, logger);
  return repoDb.getFinding(findingId);
}

function regenTargetSessionId(repoDb: RepoStore): string | null {
  const latestBrief = repoDb.getLatestBrief();
  if (latestBrief) return latestBrief.sessionId;
  // Enough recent sessions to find one that's actually ended even if the
  // very latest few are still in progress; not exhaustive, but a brief has
  // never existed for this repo yet, so there's no stale content to fix.
  return repoDb.listSessions({ limit: 100 }).find((s) => s.endedAt !== null)?.id ?? null;
}
