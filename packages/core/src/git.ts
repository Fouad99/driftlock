import { execFileSync } from 'node:child_process';
import type { GitContext } from './interfaces/git-context.ts';

// Small git probe shared by the CLI (`report`) and the daemon (session-end
// analysis) — both need `commit_link`'s git context and basic repo state.

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function currentBranch(repoRoot: string): string | null {
  const branch = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return branch && branch !== 'HEAD' ? branch : branch;
}

export function headSha(repoRoot: string): string | null {
  return git(repoRoot, ['rev-parse', 'HEAD']);
}

export function isDirty(repoRoot: string): boolean {
  const status = git(repoRoot, ['status', '--porcelain']);
  return !!status && status.length > 0;
}

/** Best-effort git context for `commit_link`; returns null if not resolvable (e.g. not a git repo, or refs missing). */
export function buildGitContext(
  repoRoot: string,
  headBefore: string | null,
  headAfter: string | null,
): GitContext | null {
  if (!headBefore && !headAfter) return null;
  const range =
    headBefore && headAfter && headBefore !== headAfter ? `${headBefore}..${headAfter}` : null;
  const commits = range
    ? (git(repoRoot, ['rev-list', range])?.split('\n').filter(Boolean) ?? [])
    : [];
  const diffPaths = range
    ? (git(repoRoot, ['diff', '--name-only', range])?.split('\n').filter(Boolean) ?? [])
    : [];
  return { headBefore, headAfter, diffPaths, commits };
}
