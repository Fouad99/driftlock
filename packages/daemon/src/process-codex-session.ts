import {
  type SessionFile,
  ingestCodexTranscript,
  readCodexSessionMeta,
} from '@driftlock/adapter-codex';
import type { Logger, RegistryStore, Repo } from '@driftlock/core';
import { noopLogger, openRepoDb, pathsEqual, repoDbPath, syncSessionIndex } from '@driftlock/core';
import { analyzeAndStore } from './analyze-and-store.ts';

// Architecture doc §4.2 — "Analyzer runner. Triggered on session_end. Runs
// all enabled analyzers, writes findings [...] and to the store."

/** Finds the registered repo (if any) whose root matches this transcript's cwd. */
export function matchRepo(repos: Repo[], sessionCwd: string): Repo | undefined {
  return repos.find((r) => pathsEqual(r.root, sessionCwd));
}

export interface ProcessResult {
  repoId: string;
  sessionId: string;
  findingsCount: number;
}

/** Ingests one changed/new Codex transcript file and, if it's new, runs analyzers over it. */
export async function processCodexSessionFile(
  file: SessionFile,
  registryDb: RegistryStore,
  logger: Logger = noopLogger,
): Promise<ProcessResult | null> {
  const meta = readCodexSessionMeta(file.path);
  if (!meta) return null;
  const repo = matchRepo(registryDb.listRepos(), meta.cwd);
  if (!repo) return null;

  const repoDb = openRepoDb(repoDbPath(repo.root));
  try {
    const sessionId = await ingestCodexTranscript(file, repo.root, repoDb);
    if (!sessionId) return null; // already ingested, or not a valid transcript

    const findingsCount = await analyzeAndStore(sessionId, repo.root, repoDb, logger);
    syncSessionIndex(registryDb, repoDb, repo.repoId, sessionId);
    registryDb.upsertRepo({ ...repo, lastSeen: Date.now() });
    logger.info('ingested and analyzed codex session', {
      repoId: repo.repoId,
      sessionId,
      findingsCount,
    });
    return { repoId: repo.repoId, sessionId, findingsCount };
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
