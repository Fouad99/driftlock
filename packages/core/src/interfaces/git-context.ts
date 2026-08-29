// Minimal git context handed to analyzers with `needs.git` — diff HEAD_before..HEAD_after
// plus reflog, per architecture doc §6.1. Populated by the daemon, not by core.

export interface GitContext {
  headBefore: string | null;
  headAfter: string | null;
  diffPaths: string[];
  commits: string[]; // shas between headBefore..headAfter
}
