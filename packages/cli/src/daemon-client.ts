import { driftlockHome } from '@driftlock/core';
import { readDaemonJson } from '@driftlock/daemon';

// M3 (05-UI.md §4.2) — mutation commands (`resolve`, `add-to-brief`) route
// through a running daemon's `/api/*` when one is up, rather than writing
// to the repo/registry SQLite files directly. This is what makes a
// CLI-originated mutation visible over `/api/events` (SSE) to any connected
// browser tab: the daemon's own update bus only sees writes that happen
// *inside* the daemon process (`bus.ts`) — a direct DB write from a
// separate CLI process is invisible to it no matter what. When no daemon is
// running, there's no live subscriber to miss anyway, so a direct DB write
// (the pre-M3 behavior) is exactly as good and needs no daemon to exist.

const HEALTH_CHECK_TIMEOUT_MS = 300;

export interface DaemonConnection {
  baseUrl: string;
  token: string;
}

/** A reachable, healthy daemon's connection info, or `null` if none is running (missing/stale `daemon.json`, or it doesn't answer `/health`) — callers fall back to a direct DB write in that case. */
export async function findRunningDaemon(): Promise<DaemonConnection | null> {
  const info = readDaemonJson(driftlockHome());
  if (!info) return null;
  const baseUrl = `http://127.0.0.1:${info.port}`;
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
  } catch {
    return null; // stale daemon.json (process no longer running) or genuinely unreachable
  }
  return { baseUrl, token: info.token };
}
