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

export type GitStatus = 'clean' | 'dirty' | 'unavailable';

/**
 * Three-state git status: `'unavailable'` when the repo root isn't a git
 * repo (or `git` fails for any other reason) — distinct from `'clean'`, so a
 * caller like the Overview screen's cached git-state column can show "not a
 * git repo" instead of silently reading as clean. See `isDirty` below,
 * which — for its existing callers, which only ever wanted a yes/no answer
 * for a status line or brief text — collapses `'unavailable'` into `false`
 * rather than surfacing it.
 */
export function gitStatus(repoRoot: string): GitStatus {
  const status = git(repoRoot, ['status', '--porcelain']);
  if (status === null) return 'unavailable';
  return status.length > 0 ? 'dirty' : 'clean';
}

export function isDirty(repoRoot: string): boolean {
  return gitStatus(repoRoot) === 'dirty';
}

const SHA_RE = /^[0-9a-f]{4,40}$/i;

/**
 * Bounded `git show` for the Session header's commit modal. Rejects
 * anything that isn't a plain hex sha (never pass a ref expression like
 * `HEAD~1` or `--flag`-shaped input through to `git show` unvalidated —
 * that's an argument-injection surface once this is reachable from an HTTP
 * route). `maxBuffer`/`timeout` cap a pathological huge or hung diff so one
 * bad request can't tie up the daemon.
 */
export function showCommit(repoRoot: string, sha: string): string | null {
  if (!SHA_RE.test(sha)) return null;
  try {
    return execFileSync('git', ['show', '--stat', '-p', sha], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 2 * 1024 * 1024,
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
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
