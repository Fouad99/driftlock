import type { Event, Session, Task } from '@driftlock/core';

// Minimal stand-in for `TranscriptTaskSource` (architecture doc §4.4, built out
// properly in M2): first user prompt, falling back to the session's own
// captured task text.
export function deriveTask(session: Session, events: Event[]): Task | undefined {
  if (session.taskText) return { text: session.taskText, source: 'transcript' };
  const firstUserTurn = events.find((e) => e.kind === 'user_turn');
  if (firstUserTurn?.kind === 'user_turn')
    return { text: firstUserTurn.payload.text, source: 'transcript' };
  return undefined;
}
