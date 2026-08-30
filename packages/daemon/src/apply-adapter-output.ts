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
      // Reuses an existing session for this (agent, agentSession) rather
      // than creating a duplicate — e.g. a Codex SessionStart hook arriving
      // after the transcript watcher already opened the same session (the
      // daemon restarted mid-session). See `getOrCreateSessionByAgentSession`.
      const { session } = repoDb.getOrCreateSessionByAgentSession(output.session);
      // Marked here (not inferred from event rows) because a session whose
      // only hook activity ends up being SessionStart + SessionEnd, with no
      // tool calls or prompts in between, writes zero `events` rows — but
      // is unambiguously hook-backed and must never be idle-reopened by the
      // transcript watcher. See `markSessionHookBacked`.
      repoDb.markSessionHookBacked(session.id);
      return { sessionId: session.id, sessionEnded: false };
    }
    case 'events': {
      if (!repoDb.getSession(output.sessionId)) return null;
      repoDb.appendEvents(output.sessionId, output.events, 'hooks');
      repoDb.markSessionHookBacked(output.sessionId);
      return { sessionId: output.sessionId, sessionEnded: false };
    }
    case 'session_end': {
      if (!repoDb.getSession(output.sessionId)) return null;
      repoDb.endSession(output.sessionId, Date.now(), output.reason);
      repoDb.markSessionHookBacked(output.sessionId);
      return { sessionId: output.sessionId, sessionEnded: true };
    }
    default:
      return null;
  }
}
