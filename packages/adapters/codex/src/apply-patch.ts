import type { Hunk } from '@driftlock/core';

export interface PatchFileEdit {
  path: string;
  hunks: Hunk[];
}

const FILE_MARKER = /^\*\*\* (Update File|Add File|Delete File): (.+)$/;

/**
 * Minimal parser for the `apply_patch` tool's custom patch format (a series
 * of `*** Update File: <path>` / `*** Add File: <path>` sections, each
 * followed by `@@`-delimited hunks of `-`/`+` lines). Line numbers are not
 * carried by this format, so `oldStart`/`newStart` are best-effort (0) —
 * good enough for the analyzers that only need touched paths and hunk size.
 */
export function parseApplyPatch(patchText: string): PatchFileEdit[] {
  const lines = patchText.split('\n');
  const edits: PatchFileEdit[] = [];
  let current: PatchFileEdit | null = null;
  let hunkLines: string[] = [];

  const flushHunk = () => {
    if (current && hunkLines.length > 0) {
      const oldLines = hunkLines.filter((l) => l.startsWith('-')).length;
      const newLines = hunkLines.filter((l) => l.startsWith('+')).length;
      current.hunks.push({
        oldStart: 0,
        oldLines,
        newStart: 0,
        newLines,
        text: hunkLines.join('\n'),
      });
    }
    hunkLines = [];
  };

  for (const line of lines) {
    const fileMatch = line.match(FILE_MARKER);
    if (fileMatch) {
      flushHunk();
      current = { path: fileMatch[2] as string, hunks: [] };
      edits.push(current);
      continue;
    }
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) {
      flushHunk();
      continue;
    }
    if (line === '@@' || line.startsWith('@@ ')) {
      flushHunk();
      continue;
    }
    if (current && (line.startsWith('-') || line.startsWith('+') || line.startsWith(' '))) {
      hunkLines.push(line);
    }
  }
  flushHunk();

  return edits;
}
