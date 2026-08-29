import type { Analyzer, Event, Hunk, NewFinding } from '@driftlock/core';

// Architecture doc §6.2 — revert: hunks that cancel earlier hunks on the same
// path within the session. Ratio over total edits.
//
// Heuristic: a hunk's added lines equal an earlier hunk's removed lines (on
// the same path, order-independent) — i.e. the edit puts back what a prior
// edit took out.

function linesOf(hunk: Hunk, prefix: '+' | '-'): string[] {
  return hunk.text
    .split('\n')
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(1).trim())
    .sort();
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((l, i) => l === b[i]);
}

export const revertAnalyzer: Analyzer = {
  id: 'revert',
  needs: {},
  async run({ session, events }): Promise<NewFinding[]> {
    const editsByPath = new Map<string, Extract<Event, { kind: 'file_edit' }>[]>();
    let totalHunks = 0;
    for (const e of events) {
      if (e.kind !== 'file_edit') continue;
      totalHunks += e.payload.hunks.length;
      const list = editsByPath.get(e.payload.path) ?? [];
      list.push(e);
      editsByPath.set(e.payload.path, list);
    }
    if (totalHunks === 0) return [];

    let revertedHunks = 0;
    const revertedPaths = new Set<string>();
    let firstSeq: number | null = null;
    let lastSeq: number | null = null;

    for (const [path, edits] of editsByPath) {
      const priorRemoved: string[][] = [];
      for (const edit of edits) {
        for (const hunk of edit.payload.hunks) {
          const added = linesOf(hunk, '+');
          const removed = linesOf(hunk, '-');
          if (priorRemoved.some((r) => sameLines(r, added))) {
            revertedHunks += 1;
            revertedPaths.add(path);
            firstSeq = firstSeq === null ? edit.seq : Math.min(firstSeq, edit.seq);
            lastSeq = lastSeq === null ? edit.seq : Math.max(lastSeq, edit.seq);
          }
          if (removed.length > 0) priorRemoved.push(removed);
        }
      }
    }

    if (revertedHunks === 0) return [];

    const ratio = revertedHunks / totalHunks;
    return [
      {
        sessionId: session.id,
        analyzer: 'revert',
        severity: ratio > 0.2 ? 'warn' : 'info',
        title: `${revertedHunks} edit(s) reverted earlier changes (${Math.round(ratio * 100)}% of hunks)`,
        explanation: `On ${revertedPaths.size} file(s), a later edit put back lines an earlier edit had removed.`,
        fromSeq: firstSeq,
        toSeq: lastSeq,
        data: { revertedHunks, totalHunks, ratio, paths: [...revertedPaths] },
      },
    ];
  },
};
