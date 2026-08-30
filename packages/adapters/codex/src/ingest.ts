import { readFileSync } from 'node:fs';
import type { RepoStore } from '@driftlock/core';
import { pathsEqual } from '@driftlock/core';
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

/**
 * Fully parses one transcript and stores it, skipping if already ingested
 * (by agent session id). Returns the stored session's id, or null if it was
 * already present or the file wasn't a valid Codex transcript.
 *
 * v0 limitation: ingestion is whole-file, once. A transcript that keeps
 * growing after its session is first seen (still-live) won't be re-parsed —
 * incremental re-ingestion needs real streaming support in `parseTranscript`,
 * which is out of scope for M1.
 */
export async function ingestCodexTranscript(
  file: SessionFile,
  repoRoot: string,
  repoDb: RepoStore,
): Promise<string | null> {
  const meta = readCodexSessionMeta(file.path);
  if (!meta) return null;
  if (repoDb.getSessionByAgentSession('codex', meta.id)) return null;

  const adapter = new CodexAdapter();
  let sessionId: string | undefined;
  let lastEventTs: number | undefined;
  for await (const output of adapter.parseTranscript(
    { path: file.path, repoRoot },
    { repo: { root: repoRoot, repoId: '' } },
  )) {
    if (output.kind === 'session_start') {
      sessionId = repoDb.createSession(output.session).id;
    } else if (output.kind === 'events' && sessionId) {
      repoDb.appendEvents(sessionId, output.events);
      for (const e of output.events) lastEventTs = Math.max(lastEventTs ?? 0, e.ts);
    } else if (output.kind === 'session_end' && sessionId) {
      // session_end carries no timestamp of its own (architecture doc's
      // AdapterOutput shape) — the last event's ts is the closest real
      // approximation of when the session actually ended.
      repoDb.endSession(sessionId, lastEventTs ?? Date.now(), output.reason);
    }
  }
  return sessionId ?? null;
}

/** Scans `~/.codex/sessions/` for transcripts belonging to `repoRoot` and ingests any not already stored. */
export async function findAndIngestCodexSessions(
  repoRoot: string,
  repoDb: RepoStore,
): Promise<string[]> {
  const files = listSessionFiles(codexSessionsDir());
  const ingested: string[] = [];
  for (const file of files) {
    const meta = readCodexSessionMeta(file.path);
    if (!meta || !pathsEqual(meta.cwd, repoRoot)) continue;
    const sessionId = await ingestCodexTranscript(file, repoRoot, repoDb);
    if (sessionId) ingested.push(sessionId);
  }
  return ingested;
}
