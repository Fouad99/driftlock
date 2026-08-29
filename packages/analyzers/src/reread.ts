import type { Analyzer, NewFinding } from '@driftlock/core';

// Architecture doc §6.2 — reread: ratio of file_read on already-read paths;
// a spike after a compaction is `warn`.

const WARN_RATIO = 0.3;

export const rereadAnalyzer: Analyzer = {
  id: 'reread',
  needs: {},
  async run({ session, events }): Promise<NewFinding[]> {
    const fileReads = events.filter((e) => e.kind === 'file_read');
    if (fileReads.length === 0) return [];

    const firstCompactionSeq = events.find((e) => e.kind === 'compaction')?.seq ?? null;

    const seen = new Set<string>();
    let rereads = 0;
    let rereadsAfterCompaction = 0;
    for (const e of fileReads) {
      if (e.kind !== 'file_read') continue;
      const path = e.payload.path;
      if (seen.has(path)) {
        rereads += 1;
        if (firstCompactionSeq !== null && e.seq > firstCompactionSeq) rereadsAfterCompaction += 1;
      }
      seen.add(path);
    }

    if (rereads === 0) return [];

    const ratio = rereads / fileReads.length;
    const severity = ratio > WARN_RATIO || rereadsAfterCompaction > 0 ? 'warn' : 'info';

    return [
      {
        sessionId: session.id,
        analyzer: 'reread',
        severity,
        title: `${rereads} re-read${rereads === 1 ? '' : 's'} of already-read files (${Math.round(ratio * 100)}%)`,
        explanation:
          rereadsAfterCompaction > 0
            ? `${rereadsAfterCompaction} of those re-reads happened after a compaction, suggesting lost context.`
            : 'Files were read more than once in the same session.',
        fromSeq: fileReads[0]?.seq ?? null,
        toSeq: fileReads[fileReads.length - 1]?.seq ?? null,
        data: { rereads, totalReads: fileReads.length, ratio, rereadsAfterCompaction },
      },
    ];
  },
};
