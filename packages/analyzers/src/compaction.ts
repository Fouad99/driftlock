import type { Analyzer, Event, NewFinding } from '@driftlock/core';

// Architecture doc §6.2 — compaction: count, position as fraction of session,
// warn if a user_turn preceded the first compaction (instructions at risk of
// being dropped).

export const compactionAnalyzer: Analyzer = {
  id: 'compaction',
  needs: {},
  async run({ session, events }): Promise<NewFinding[]> {
    const compactions = events.filter(
      (e): e is Extract<Event, { kind: 'compaction' }> => e.kind === 'compaction',
    );
    if (compactions.length === 0) return [];

    const total = events.length;
    const first = compactions[0] as Extract<Event, { kind: 'compaction' }>;
    const position = total > 0 ? first.seq / total : 0;
    const userTurnsBefore = events.filter(
      (e) => e.kind === 'user_turn' && e.seq < first.seq,
    ).length;

    const severity =
      compactions.length > 1 || (position < 0.5 && userTurnsBefore > 0) ? 'warn' : 'info';

    return [
      {
        sessionId: session.id,
        analyzer: 'compaction',
        severity,
        title:
          compactions.length === 1
            ? `1 compaction at ${Math.round(position * 100)}% of the session`
            : `${compactions.length} compactions, first at ${Math.round(position * 100)}%`,
        explanation:
          userTurnsBefore > 0
            ? `${userTurnsBefore} user instruction(s) preceded the first compaction and may have been dropped from context.`
            : 'No user instructions preceded the first compaction.',
        fromSeq: first.seq,
        toSeq: compactions[compactions.length - 1]?.seq ?? first.seq,
        data: { count: compactions.length, firstPosition: position, userTurnsBefore },
      },
    ];
  },
};
