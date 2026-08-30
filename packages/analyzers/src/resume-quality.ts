import type { Analyzer, NewFinding } from '@driftlock/core';

// Architecture doc §6.2 — "resume_quality: Handoff quality. For sessions
// starting after a gap > N days: turns before first file_edit, count of
// clarifying agent_turns. Scores the memory layer, not the agent."
//
// "Clarifying agent_turn" has no structured signal to key on (no LLM judge
// in the deterministic tier) — approximated as an `agent_turn` whose text
// contains a `?`, occurring before the first `file_edit` (i.e. the agent
// asking rather than acting yet). A worse resume brief should correlate
// with more of these and more turns before real work starts.

const GAP_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // matches M2's own exit criterion: "leave a repo for ≥ 3 days"

export const resumeQualityAnalyzer: Analyzer = {
  id: 'resume_quality',
  needs: { previousSession: true },
  async run({ session, events, previousSessionEndedAt }): Promise<NewFinding[]> {
    if (previousSessionEndedAt === undefined || previousSessionEndedAt === null) return [];
    const gapMs = session.startedAt - previousSessionEndedAt;
    if (gapMs <= GAP_THRESHOLD_MS) return [];
    if (events.length === 0) return [];

    const firstEditSeq =
      events.find((e) => e.kind === 'file_edit')?.seq ?? Number.POSITIVE_INFINITY;
    const preEditEvents = events.filter((e) => e.seq < firstEditSeq);

    const turnsBeforeFirstEdit = preEditEvents.filter(
      (e) => e.kind === 'user_turn' || e.kind === 'agent_turn',
    ).length;
    const clarifyingTurns = preEditEvents.filter(
      (e) => e.kind === 'agent_turn' && e.payload.text.includes('?'),
    ).length;

    const gapDays = Math.round(gapMs / (24 * 60 * 60 * 1000));

    return [
      {
        sessionId: session.id,
        analyzer: 'resume_quality',
        severity: 'info',
        title: `resumed after ${gapDays} day(s): ${turnsBeforeFirstEdit} turn(s) and ${clarifyingTurns} clarifying question(s) before the first edit`,
        explanation:
          'Scores the memory layer (resume brief), not the agent — a high turn/question count on a long-gap resume suggests the brief did not carry enough context.',
        fromSeq: events[0]?.seq ?? null,
        toSeq:
          firstEditSeq === Number.POSITIVE_INFINITY ? (events.at(-1)?.seq ?? null) : firstEditSeq,
        data: { gapDays, turnsBeforeFirstEdit, clarifyingTurns },
      },
    ];
  },
};
