import type { Analyzer, Event, NewFinding } from '@driftlock/core';

// Architecture doc §6.2 — loop: >=3 consecutive edit->test->edit cycles on the
// same path, or >=3 identical tool-call hashes. Default cycle threshold
// matches the usage doc's `[analyzers.loop] cycles = 3`.

const DEFAULT_CYCLE_THRESHOLD = 3;

function toolCallHash(e: Extract<Event, { kind: 'tool_call' }>): string {
  return `${e.payload.name}:${JSON.stringify(e.payload.args)}`;
}

export const loopAnalyzer: Analyzer = {
  id: 'loop',
  needs: {},
  async run({ session, events }): Promise<NewFinding[]> {
    const findings: NewFinding[] = [];

    // edit -> test -> edit cycles per path
    const editsByPath = new Map<string, number[]>();
    const testSeqs: number[] = [];
    for (const e of events) {
      if (e.kind === 'file_edit') {
        const list = editsByPath.get(e.payload.path) ?? [];
        list.push(e.seq);
        editsByPath.set(e.payload.path, list);
      } else if (e.kind === 'test_run') {
        testSeqs.push(e.seq);
      }
    }

    for (const [path, seqs] of editsByPath) {
      let cycles = 0;
      let firstSeq: number | null = null;
      for (let i = 1; i < seqs.length; i++) {
        const prev = seqs[i - 1] as number;
        const curr = seqs[i] as number;
        const hasTestBetween = testSeqs.some((t) => t > prev && t < curr);
        if (hasTestBetween) {
          cycles += 1;
          if (firstSeq === null) firstSeq = prev;
        }
      }
      if (cycles >= DEFAULT_CYCLE_THRESHOLD) {
        findings.push({
          sessionId: session.id,
          analyzer: 'loop',
          severity: 'warn',
          title: `${cycles} edit/test cycles on ${path}`,
          explanation: `The same file was edited, tested, and edited again ${cycles} times in this session.`,
          fromSeq: firstSeq,
          toSeq: seqs[seqs.length - 1] ?? null,
          data: { path, cycles },
        });
      }
    }

    // identical tool-call hashes
    const callsByHash = new Map<string, Extract<Event, { kind: 'tool_call' }>[]>();
    for (const e of events) {
      if (e.kind !== 'tool_call') continue;
      const hash = toolCallHash(e);
      const list = callsByHash.get(hash) ?? [];
      list.push(e);
      callsByHash.set(hash, list);
    }
    for (const [hash, calls] of callsByHash) {
      if (calls.length >= DEFAULT_CYCLE_THRESHOLD) {
        findings.push({
          sessionId: session.id,
          analyzer: 'loop',
          severity: 'warn',
          title: `${calls.length} identical tool calls (${calls[0]?.payload.name})`,
          explanation: `The same tool call (by name and arguments) repeated ${calls.length} times.`,
          fromSeq: calls[0]?.seq ?? null,
          toSeq: calls[calls.length - 1]?.seq ?? null,
          data: { hash, count: calls.length, name: calls[0]?.payload.name },
        });
      }
    }

    return findings;
  },
};
