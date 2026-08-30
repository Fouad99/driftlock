import {
  DEFAULT_IDLE_THRESHOLD_MS,
  type SessionFile,
  readCodexSessionMeta,
  syncAndMaybeFinalize,
} from '@driftlock/adapter-codex';
import type { Logger, RegistryStore, Repo } from '@driftlock/core';
import { noopLogger, openRepoDb, pathsEqual, repoDbPath, syncSessionIndex } from '@driftlock/core';
import { analyzeAndStore } from './analyze-and-store.ts';

// Architecture doc §4.2 — "Analyzer runner. Triggered on session_end. Runs
// all enabled analyzers, writes findings [...] and to the store." A Codex
// session's "end" is a heuristic (file gone idle — see adapter-codex's
// `syncCodexSessionFile`), so this runs the analyzers only once that
// heuristic fires, not on every intermediate sync of a still-growing file.

/** Finds the registered repo (if any) whose root matches this transcript's cwd. */
export function matchRepo(repos: Repo[], sessionCwd: string): Repo | undefined {
  return repos.find((r) => pathsEqual(r.root, sessionCwd));
}

export interface ProcessResult {
  repoId: string;
  sessionId: string;
  finalized: boolean;
  findingsCount: number;
}

/** Syncs one changed/new Codex transcript file and, once its session has gone idle, runs analyzers over it. */
export async function processCodexSessionFile(
  file: SessionFile,
  registryDb: RegistryStore,
  logger: Logger = noopLogger,
  idleThresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
): Promise<ProcessResult | null> {
  const meta = readCodexSessionMeta(file.path);
  if (!meta) return null;
  const repo = matchRepo(registryDb.listRepos(), meta.cwd);
  if (!repo) return null;

  const repoDb = openRepoDb(repoDbPath(repo.root));
  try {
    const synced = await syncAndMaybeFinalize(file, repo.root, repoDb, { logger, idleThresholdMs });
    if (!synced) return null; // parse failed (will retry next change), or already finalized

    const findingsCount = synced.finalized
      ? await analyzeAndStore(synced.sessionId, repo.root, repoDb, logger)
      : 0;
    syncSessionIndex(registryDb, repoDb, repo.repoId, synced.sessionId);
    registryDb.upsertRepo({ ...repo, lastSeen: Date.now() });
    logger.info(
      synced.finalized ? 'finalized and analyzed codex session' : 'synced codex session',
      {
        repoId: repo.repoId,
        sessionId: synced.sessionId,
        finalized: synced.finalized,
        findingsCount,
      },
    );
    return {
      repoId: repo.repoId,
      sessionId: synced.sessionId,
      finalized: synced.finalized,
      findingsCount,
    };
  } catch (err) {
    logger.error('failed to process codex session file', {
      file: file.path,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    repoDb.close();
  }
}
