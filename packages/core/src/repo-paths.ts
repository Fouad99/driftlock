import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Architecture doc §5.4 — files in the repo: `.driftlock/db.sqlite`,
// `.driftlock/meta.json` (gitignored); `DECISIONS.md` (committed).
// Shared between the CLI (locating "the repo I'm standing in") and the
// daemon (locating "the repo this registry entry points at").

export interface RepoMeta {
  repoId: string;
}

/** Walks up from `cwd` looking for a `.git` directory (or file, for worktrees). */
export function findRepoRoot(cwd: string): string | null {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function driftlockDir(repoRoot: string): string {
  return join(repoRoot, '.driftlock');
}

export function repoDbPath(repoRoot: string): string {
  return join(driftlockDir(repoRoot), 'db.sqlite');
}

function metaPath(repoRoot: string): string {
  return join(driftlockDir(repoRoot), 'meta.json');
}

export function readRepoMeta(repoRoot: string): RepoMeta | null {
  const p = metaPath(repoRoot);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8')) as RepoMeta;
}

export function writeRepoMeta(repoRoot: string, meta: RepoMeta): void {
  mkdirSync(driftlockDir(repoRoot), { recursive: true });
  writeFileSync(metaPath(repoRoot), `${JSON.stringify(meta, null, 2)}\n`);
}
