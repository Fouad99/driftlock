import type { SseEvent } from '@driftlock/core';

// M3 (05-UI.md §4.2) — the daemon-process-local update bus behind `GET
// /api/events` (SSE). Every write path that runs *inside* the daemon
// process (the `/hook` handler, the Codex transcript watcher, the `/api/*`
// mutation routes) publishes here after its DB transaction commits, and
// every connected browser tab subscribes.
//
// This alone does NOT see a write made by a separate `driftlock` CLI
// process talking directly to the same SQLite files — an in-process
// `EventEmitter`-style bus structurally can't. That gap is closed on the
// CLI side, not here: `packages/cli/src/resolve.ts` and `pin.ts` route
// their mutation through the running daemon's `/api/*` (so the daemon's own
// publish above fires) whenever a daemon is reachable, and fall back to a
// direct DB write — with no live publish — only when none is running. See
// those files' `mutateViaDaemonOrDirect` helper.
export class UpdateBus {
  private listeners = new Set<(event: SseEvent) => void>();

  publish(event: SseEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Returns an unsubscribe function. */
  subscribe(listener: (event: SseEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
