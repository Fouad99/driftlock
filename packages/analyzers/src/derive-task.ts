import type { Event, Session, Task } from '@driftlock/core';

// Minimal stand-in for `TranscriptTaskSource` (architecture doc §4.4, built
// out properly in M2): the session's own captured task text, falling back to
// the first user prompt. Shared by the CLI and the daemon so both get the
// same (better) task inference — the daemon's analyzer runner previously
// only checked `session.taskText`, which is always null for Claude Code
// sessions (that adapter never sets it), so `scope` never had anything to
// compare against for hook-driven sessions.
export function deriveTask(session: Session, events: Event[]): Task | undefined {
  if (session.taskText) return { text: session.taskText, source: 'transcript' };
  const firstUserTurn = events.find((e) => e.kind === 'user_turn');
  if (firstUserTurn?.kind === 'user_turn')
    return { text: firstUserTurn.payload.text, source: 'transcript' };
  return undefined;
}
