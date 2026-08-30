import type { Analyzer, NewFinding } from '@driftlock/core';

// Architecture doc §6.2 — commit_link: map session to commits via
// head_before..head_after. Enables "sessions whose commits were reverted"
// later (backlog `outcome_regression`); for now it's an info annotation.

export const commitLinkAnalyzer: Analyzer = {
  id: 'commit_link',
  needs: { git: true },
  async run({ session, git }): Promise<NewFinding[]> {
    if (!git || git.commits.length === 0) return [];

    return [
      {
        sessionId: session.id,
        analyzer: 'commit_link',
        severity: 'info',
        title: `${git.commits.length} commit(s) linked to this session`,
        explanation: `${git.headBefore ?? '(unknown)'}..${git.headAfter ?? '(unknown)'}`,
        fromSeq: null,
        toSeq: null,
        data: { commits: git.commits, diffPaths: git.diffPaths },
      },
    ];
  },
};
