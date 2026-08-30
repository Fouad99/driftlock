import type { AdapterOutput, RepoStore } from '@driftlock/core';

export interface AppliedOutput {
  sessionId: string;
  sessionEnded: boolean;
}

/**
 * Persists one `AdapterOutput` from a push-based adapter's `onHook` (Claude
 * Code, later Cursor). `request`-kind outputs (resume brief, drift verdict)
 * aren't handled here — those land in M2/M4/M6.
 *
 * v0 limitation: if `events`/`session_end` arrives for a session whose
 * `session_start` was never persisted (e.g. the daemon was down when the
 * agent's session began and only came back up mid-session), those events are
 * dropped rather than synthesizing a session — the next real `SessionStart`
 * recovers cleanly. Documented, not silently "fixed", since guessing at a
 * session's missing start fields would fabricate data.
 */
export function applyAdapterOutput(output: AdapterOutput, repoDb: RepoStore): AppliedOutput | null {
  switch (output.kind) {
    case 'session_start': {
      const session = repoDb.createSession(output.session);
      return { sessionId: session.id, sessionEnded: false };
    }
    case 'events': {
      if (!repoDb.getSession(output.sessionId)) return null;
      repoDb.appendEvents(output.sessionId, output.events);
      return { sessionId: output.sessionId, sessionEnded: false };
    }
    case 'session_end': {
      if (!repoDb.getSession(output.sessionId)) return null;
      repoDb.endSession(output.sessionId, Date.now(), output.reason);
      return { sessionId: output.sessionId, sessionEnded: true };
    }
    default:
      return null;
  }
}
