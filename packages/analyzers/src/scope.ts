import type { Analyzer, Event, NewFinding } from '@driftlock/core';

// Architecture doc §6.2 — scope: edited paths vs. paths inferred from task
// text (mentioned files, directories, symbols) and plan items. Reports
// out-of-scope files ranked by hunk size.

const PATH_TOKEN_PATTERN = /[\w.-]+\/[\w./-]+|\b[\w-]+\.[a-z]{1,5}\b/gi;

function extractPathTokens(text: string): string[] {
  return [...text.matchAll(PATH_TOKEN_PATTERN)].map((m) => m[0].toLowerCase());
}

function isInScope(path: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true; // nothing to compare against; don't guess
  const lowerPath = path.toLowerCase();
  const basename = lowerPath.split('/').pop() ?? lowerPath;
  return tokens.some((t) => lowerPath.includes(t) || t.includes(basename));
}

function hunkSize(edit: Extract<Event, { kind: 'file_edit' }>): number {
  return edit.payload.hunks.reduce((sum, h) => sum + h.oldLines + h.newLines, 0);
}

export const scopeAnalyzer: Analyzer = {
  id: 'scope',
  needs: { task: true },
  async run({ session, events, task }): Promise<NewFinding[]> {
    const tokens = [
      ...(task ? extractPathTokens(task.text) : []),
      ...events
        .filter((e) => e.kind === 'plan_item')
        .flatMap((e) => (e.kind === 'plan_item' ? extractPathTokens(e.payload.text) : [])),
    ];
    if (tokens.length === 0) return [];

    const sizeByPath = new Map<string, number>();
    let firstSeq: number | null = null;
    let lastSeq: number | null = null;
    for (const e of events) {
      if (e.kind !== 'file_edit') continue;
      if (isInScope(e.payload.path, tokens)) continue;
      sizeByPath.set(e.payload.path, (sizeByPath.get(e.payload.path) ?? 0) + hunkSize(e));
      firstSeq = firstSeq === null ? e.seq : Math.min(firstSeq, e.seq);
      lastSeq = lastSeq === null ? e.seq : Math.max(lastSeq, e.seq);
    }

    if (sizeByPath.size === 0) return [];

    const ranked = [...sizeByPath.entries()].sort((a, b) => b[1] - a[1]);

    return [
      {
        sessionId: session.id,
        analyzer: 'scope',
        severity: 'warn',
        title: `${ranked.length} file(s) edited outside the task's apparent scope`,
        explanation: `Edited but not mentioned in the task or plan: ${ranked.map(([p]) => p).join(', ')}`,
        fromSeq: firstSeq,
        toSeq: lastSeq,
        data: { files: ranked.map(([path, size]) => ({ path, size })) },
      },
    ];
  },
};
