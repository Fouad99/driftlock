import type { Analyzer, NewFinding } from '@driftlock/core';

// Architecture doc §6.2 — test_before_claim: last agent_turn containing
// completion language with no test_run after the last file_edit.

const COMPLETION_PATTERN = /\b(done|complete[d]?|finished|fixed|all set|should work now)\b/i;

export const testBeforeClaimAnalyzer: Analyzer = {
  id: 'test_before_claim',
  needs: {},
  async run({ session, events }): Promise<NewFinding[]> {
    const agentTurns = events.filter((e) => e.kind === 'agent_turn');
    const lastClaim = [...agentTurns]
      .reverse()
      .find((e) => e.kind === 'agent_turn' && COMPLETION_PATTERN.test(e.payload.text));
    if (!lastClaim) return [];

    const lastEdit = [...events].reverse().find((e) => e.kind === 'file_edit');
    if (!lastEdit) return [];
    if (lastClaim.seq < lastEdit.seq) return []; // claim came before the edit; not a completion claim on this work

    const testAfterEdit = events.some((e) => e.kind === 'test_run' && e.seq > lastEdit.seq);
    if (testAfterEdit) return [];

    return [
      {
        sessionId: session.id,
        analyzer: 'test_before_claim',
        severity: 'warn',
        title: `"done" claimed at seq ${lastClaim.seq} with no test run after the last edit`,
        explanation:
          'The agent declared the work finished without running tests after its last file edit.',
        fromSeq: lastEdit.seq,
        toSeq: lastClaim.seq,
        data: {},
      },
    ];
  },
};
