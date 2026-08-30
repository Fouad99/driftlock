import type { Event, Session, Task } from '@driftlock/core';

const CLOSED_PLAN_ITEM_STATUSES = new Set(['completed', 'done', 'cancelled']);

// Backing logic for `TranscriptTaskSource.current()` (architecture doc §4.4,
// M2 — see task-source.ts). Shared by the CLI and the daemon so both get the
// same task inference — the daemon's analyzer runner previously only checked
// `session.taskText`, which is always null for Claude Code sessions (that
// adapter never sets it), so `scope` never had anything to compare against
// for hook-driven sessions.
//
// Priority: `session.taskText` (an adapter-captured task, e.g. Codex's
// `session_meta.instructions`) > first user prompt (the literal ask) > the
// most recently opened, still-open `plan_item` (a fallback for sessions with
// no captured prompt at all — e.g. resumed via a hook with no transcript,
// or a subagent invocation whose "prompt" never produced a `user_turn`).
export function deriveTask(session: Session, events: Event[]): Task | undefined {
  if (session.taskText) return { text: session.taskText, source: 'transcript' };
  const firstUserTurn = events.find((e) => e.kind === 'user_turn');
  if (firstUserTurn?.kind === 'user_turn')
    return { text: firstUserTurn.payload.text, source: 'transcript' };
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.kind !== 'plan_item') continue;
    if (CLOSED_PLAN_ITEM_STATUSES.has(event.payload.status.toLowerCase())) continue;
    return { text: event.payload.text, source: 'transcript' };
  }
  return undefined;
}
