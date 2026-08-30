import { readFileSync } from 'node:fs';
import type { AdapterOutput, Logger, RepoStore } from '@driftlock/core';
import { noopLogger, pathsEqual } from '@driftlock/core';
import { CodexAdapter } from './adapter.ts';
import { type SessionFile, codexSessionsDir, listSessionFiles } from './paths.ts';

export interface CodexSessionMeta {
  id: string;
  cwd: string;
}

/** Cheap peek at a transcript's first line, without parsing the whole file. */
export function readCodexSessionMeta(filePath: string): CodexSessionMeta | null {
  let firstLine: string;
  try {
    firstLine = readFileSync(filePath, 'utf-8').split('\n', 1)[0] ?? '';
  } catch {
    return null;
  }
  if (!firstLine) return null;
  try {
    const meta = JSON.parse(firstLine) as { type?: string; id?: string; cwd?: string };
    if (meta.type !== 'session_meta' || !meta.id || !meta.cwd) return null;
    return { id: meta.id, cwd: meta.cwd };
  } catch {
    return null;
  }
}

// A Codex session is "done" when its transcript stops changing — Codex gives
// no other signal we consume (a real `notify` hook exists but isn't wired
// yet; see architecture doc §4.3's Codex row). This is a heuristic, not a
// hard fact: a long pause for user input or agent reasoning can exceed this
// threshold without the session actually being over. Getting it wrong is
// cheap and self-correcting — see `syncCodexSessionFile`'s reopen logic —
// rather than a hard fact we fabricate finality from.
export const DEFAULT_IDLE_THRESHOLD_MS = 2 * 60_000;

export function isFileIdle(file: SessionFile, idleThresholdMs: number, now = Date.now()): boolean {
  return now - file.mtimeMs >= idleThresholdMs;
}

export interface SyncResult {
  sessionId: string;
  isNewSession: boolean;
  finalized: boolean;
}

/**
 * Parses a Codex transcript and syncs it into the store — re-entrant: safe
 * to call repeatedly as the file grows. The whole file is parsed into memory
 * first; only if that fully succeeds does anything touch the database, and
 * the write (create-or-reuse the session, replace its events) happens in one
 * transaction — a parse failure (e.g. a line caught mid-write) or a mid-sync
 * crash never leaves a partial session behind to get silently stuck.
 *
 * Idle-finalization (see `finalizeIfIdle`) is a heuristic guess, not a fact —
 * a long pause for user input or agent reasoning can easily exceed the idle
 * threshold without the session actually being over. So "finalized" here is
 * reversible: if the file has grown since the mtime we finalized it at
 * (`endedAt`, which `finalizeIfIdle` sets to that mtime), the session is
 * reopened and re-synced rather than the new content being silently
 * dropped. A session is only ever truly skipped once its file's mtime stops
 * moving past what we finalized it at.
 *
 * Returns null if the file isn't a valid/parseable Codex transcript, or if
 * the session it belongs to is finalized and genuinely has nothing new.
 */
export async function syncCodexSessionFile(
  file: SessionFile,
  repoRoot: string,
  repoDb: RepoStore,
  logger: Logger = noopLogger,
): Promise<SyncResult | null> {
  const meta = readCodexSessionMeta(file.path);
  if (!meta) return null;

  let existing = repoDb.getSessionByAgentSession('codex', meta.id);
  // Once a hook has ever touched this session, hook-side SessionEnd/Stop is
  // the sole authority on when it ended — the transcript idle heuristic
  // must not finalize or reopen it (see isSessionHookBacked; this is a
  // session-level flag, not "has any event row with source='hooks'" — a
  // session whose only hook activity was SessionStart+SessionEnd writes no
  // event rows at all but is still genuinely hook-backed).
  const hookBacked = existing ? repoDb.isSessionHookBacked(existing.id) : false;
  if (!hookBacked && existing?.endedAt !== null && existing?.endedAt !== undefined) {
    if (file.mtimeMs <= existing.endedAt) {
      return null; // finalized, and nothing has changed since — truly nothing to do
    }
    // Finalized, but the file has since grown — our idle guess was wrong.
    logger.info('reopening a codex session finalized too early — the transcript grew again', {
      sessionId: existing.id,
      finalizedAtMtime: existing.endedAt,
      currentMtime: file.mtimeMs,
    });
    repoDb.reopenSession(existing.id);
    existing = repoDb.getSession(existing.id);
  }

  const adapter = new CodexAdapter();
  let sessionInit: Extract<AdapterOutput, { kind: 'session_start' }>['session'] | undefined;
  const events: Parameters<RepoStore['replaceEvents']>[1] = [];

  try {
    for await (const output of adapter.parseTranscript(
      { path: file.path, repoRoot },
      { repo: { root: repoRoot, repoId: '' } },
    )) {
      if (output.kind === 'session_start') sessionInit = output.session;
      else if (output.kind === 'events') events.push(...output.events);
      // session_end from the adapter is deliberately ignored — finalization
      // here is decided by file idleness, not by "we reached the end of
      // whatever bytes exist right now" (that was the bug: it treated every
      // scan of a still-growing file as the session having ended).
    }
  } catch (err) {
    logger.error('failed to parse codex transcript, will retry on next change', {
      file: file.path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null; // nothing persisted — safe to retry once the file changes again
  }

  if (!sessionInit) return null;

  const sessionId = repoDb.transaction(() => {
    const { session } = repoDb.getOrCreateSessionByAgentSession(sessionInit);
    // Once any hook has written into this session, its rows must never be
    // wholesale-replaced (that would renumber `seq` under hook data and
    // finding evidence pointers) — merge gap-fill only. Otherwise this is
    // the pure fallback path (hooks untrusted or never fired), unchanged
    // from M1: reparse-and-replace on every sync.
    if (repoDb.isSessionHookBacked(session.id)) {
      repoDb.mergeEvents(session.id, events);
    } else {
      repoDb.replaceEvents(session.id, events);
    }
    return session.id;
  });

  return { sessionId, isNewSession: !existing, finalized: false };
}

/**
 * Marks a session ended if its file has gone idle. No-op if already ended,
 * still active, or hook-backed — once any hook has written into a session,
 * a hook `SessionEnd`/`Stop` is the sole authority on when it ended; the
 * idle heuristic is only for the fallback path (hooks untrusted or never
 * fired).
 */
export function finalizeIfIdle(
  file: SessionFile,
  sessionId: string,
  repoDb: RepoStore,
  idleThresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
  now: number = Date.now(),
): boolean {
  const session = repoDb.getSession(sessionId);
  if (!session || session.endedAt !== null) return false;
  if (repoDb.isSessionHookBacked(sessionId)) return false;
  if (!isFileIdle(file, idleThresholdMs, now)) return false;
  repoDb.endSession(sessionId, file.mtimeMs, 'idle');
  return true;
}

/** Syncs one transcript and finalizes it if its file has gone idle. The common entry point for both the CLI and the daemon watcher. */
export async function syncAndMaybeFinalize(
  file: SessionFile,
  repoRoot: string,
  repoDb: RepoStore,
  opts: { idleThresholdMs?: number; logger?: Logger } = {},
): Promise<SyncResult | null> {
  const result = await syncCodexSessionFile(file, repoRoot, repoDb, opts.logger);
  if (!result) return null;
  const finalized = finalizeIfIdle(
    file,
    result.sessionId,
    repoDb,
    opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS,
  );
  return { ...result, finalized };
}

/** Scans `~/.codex/sessions/` for transcripts belonging to `repoRoot` and syncs any that aren't already finalized. */
export async function findAndIngestCodexSessions(
  repoRoot: string,
  repoDb: RepoStore,
  opts: { idleThresholdMs?: number; logger?: Logger } = {},
): Promise<string[]> {
  const files = listSessionFiles(codexSessionsDir());
  const synced: string[] = [];
  for (const file of files) {
    const meta = readCodexSessionMeta(file.path);
    if (!meta || !pathsEqual(meta.cwd, repoRoot)) continue;
    const result = await syncAndMaybeFinalize(file, repoRoot, repoDb, opts);
    if (result) synced.push(result.sessionId);
  }
  return synced;
}
