import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Architecture doc §8.1/§5.4 — the "written" resume-brief delivery path,
// universal across agents (no hooks needed; the agent just reads its own
// instruction file). M2 plan item 3.

const FENCE_START = '<!-- driftlock:resume -->';
const FENCE_END = '<!-- /driftlock:resume -->';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FENCE_REGEX = new RegExp(`${escapeRegExp(FENCE_START)}[\\s\\S]*?${escapeRegExp(FENCE_END)}`);

function fenceBlock(markdown: string): string {
  return `${FENCE_START}\n${markdown.trim()}\n${FENCE_END}`;
}

/**
 * Idempotently upserts the `<!-- driftlock:resume -->` fenced block into one
 * file. Everything outside the fence is preserved byte-for-byte — a file
 * with no existing fence gets the block appended (blank-line separated),
 * not clobbered; a missing file is created with just the block.
 */
export function writeFencedBlock(path: string, markdown: string): { created: boolean } {
  const created = !existsSync(path);
  const existing = created ? '' : readFileSync(path, 'utf-8');
  const block = fenceBlock(markdown);

  let next: string;
  if (FENCE_REGEX.test(existing)) {
    next = existing.replace(FENCE_REGEX, block);
  } else if (existing.trim().length === 0) {
    next = block;
  } else {
    const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    next = `${existing}${sep}${block}`;
  }
  if (!next.endsWith('\n')) next += '\n';

  writeFileSync(path, next);
  return { created };
}

export interface WriteResumeBlockResult {
  path: string;
  created: boolean;
}

const CLAUDE_MD = 'CLAUDE.md';
const AGENTS_MD = 'AGENTS.md';
const CURSOR_RULES = join('.cursor', 'rules', 'driftlock.mdc');

/**
 * Writes the resume block to every agent instruction file in the repo.
 * `CLAUDE.md`/`AGENTS.md` are created if absent, matching `init`'s own
 * scaffolding (architecture doc §5.4). `.cursor/rules/driftlock.mdc` is only
 * written if it already exists — Cursor support ships in M5, so nothing
 * here should scaffold a `.cursor/` layout on its own.
 */
export function writeResumeBriefToRepo(
  repoRoot: string,
  markdown: string,
): WriteResumeBlockResult[] {
  const results: WriteResumeBlockResult[] = [];
  for (const rel of [CLAUDE_MD, AGENTS_MD]) {
    const path = join(repoRoot, rel);
    results.push({ path, ...writeFencedBlock(path, markdown) });
  }
  const cursorPath = join(repoRoot, CURSOR_RULES);
  if (existsSync(cursorPath)) {
    results.push({ path: cursorPath, ...writeFencedBlock(cursorPath, markdown) });
  }
  return results;
}
