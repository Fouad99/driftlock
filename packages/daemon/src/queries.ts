import type {
  CommitDetail,
  EventPage,
  EventSummary,
  Finding,
  RegistryStore,
  RepoRow,
  RepoStore,
  Session,
} from '@driftlock/core';
import { showCommit } from '@driftlock/core';

// M3 (05-UI.md §4.2) — the single set of read functions behind both the
// `/api/*` routes and the CLI's `--json` output, so the two can't diverge
// into two different APIs. Nothing here writes; see `mutations.ts`.

/** Overview screen (05-UI.md §2.1) — purely from the denormalized registry, never a repo-db open or a live git probe. */
export function getRepoRows(registryDb: RegistryStore): RepoRow[] {
  return registryDb.listRepos().map((repo) => {
    const latest = registryDb.getLatestSessionIndex(repo.repoId);
    const sessions = registryDb.listSessionIndex(repo.repoId);
    const openFindings = sessions.reduce(
      (acc, s) => ({
        info: acc.info + s.openFindingsBySeverity.info,
        warn: acc.warn + s.openFindingsBySeverity.warn,
        high: acc.high + s.openFindingsBySeverity.high,
      }),
      { info: 0, warn: 0, high: 0 },
    );
    return {
      repoId: repo.repoId,
      root: repo.root,
      name: repo.name,
      agents: repo.agents,
      latestSessionId: latest?.sessionId ?? null,
      latestSessionAt: latest?.startedAt ?? null,
      latestSessionAgent: latest?.agent ?? null,
      openFindings,
      branch: repo.branch,
      gitStatus: repo.gitStatus,
      findingSparkline: registryDb.getFindingSparkline(repo.repoId),
    };
  });
}

export interface SessionDetail {
  session: Session;
  findings: Finding[];
  /** From the `commit_link` finding's `data.commits` (there is no session column for this — `commit-link.ts`). */
  linkedCommits: string[];
  /**
   * Total compaction count for the *whole* session, independent of any
   * timeline filter chip — the header stat must not fluctuate (usually to
   * zero) just because the UI is showing "edits" or "tests" (a real bug:
   * computing this from the filtered event array instead of session-wide).
   */
  compactionCount: number;
}

/** Session header (05-UI.md §2.3). */
export function getSessionDetail(repoDb: RepoStore, sessionId: string): SessionDetail | null {
  const session = repoDb.getSession(sessionId);
  if (!session) return null;
  const findings = repoDb.listFindings({ sessionId, pinnedFirst: true });
  const commitLink = findings.find((f) => f.analyzer === 'commit_link');
  const linkedCommits =
    (commitLink?.data as { commits?: string[] } | null | undefined)?.commits ?? [];
  const compactionCount = repoDb.getEvents(sessionId, { kinds: ['compaction'] }).length;
  return { session, findings, linkedCommits, compactionCount };
}

export type TimelineFilter = 'all' | 'edits' | 'tests' | 'reads' | 'findings';

const KINDS_BY_FILTER: Record<Exclude<TimelineFilter, 'all' | 'findings'>, string[]> = {
  edits: ['file_edit'],
  tests: ['test_run'],
  reads: ['file_read'],
};

/**
 * Timeline page (05-UI.md §2.3) — thin wrapper over `RepoStore.getEventPage`
 * that additionally understands `"findings"`, which isn't a real event
 * `kind` (05-UI.md §4.2): it means "events whose `seq` falls inside some
 * open finding's `fromSeq..toSeq`". That filter is applied after the page is
 * fetched, so a `"findings"`-filtered page can come back shorter than
 * `limit` even when more matching events exist later in the session —
 * acceptable for a filter chip, not used for exhaustive iteration.
 */
export function getTimelinePage(
  repoDb: RepoStore,
  sessionId: string,
  opts: { fromSeq?: number; limit?: number; filter?: TimelineFilter } = {},
): EventPage {
  const filter = opts.filter ?? 'all';
  const kinds = filter === 'all' || filter === 'findings' ? undefined : KINDS_BY_FILTER[filter];
  const page = repoDb.getEventPage(sessionId, {
    ...(opts.fromSeq !== undefined && { fromSeq: opts.fromSeq }),
    ...(opts.limit !== undefined && { limit: opts.limit }),
    ...(kinds && { kinds }),
  });
  if (filter !== 'findings') return page;
  const coveredSeqs = seqsCoveredByOpenFindings(repoDb, sessionId);
  return { ...page, events: page.events.filter((e) => coveredSeqs.has(e.seq)) };
}

function seqsCoveredByOpenFindings(repoDb: RepoStore, sessionId: string): Set<number> {
  const seqs = new Set<number>();
  for (const f of repoDb.listFindings({ sessionId, open: true })) {
    if (f.fromSeq === null || f.toSeq === null) continue;
    for (let s = f.fromSeq; s <= f.toSeq; s += 1) seqs.add(s);
  }
  return seqs;
}

/** Evidence pane's "jump to finding" (05-UI.md §2.3/§4.2). */
export function getEvidenceForFinding(
  repoDb: RepoStore,
  finding: Finding,
  padding = 3,
): EventSummary[] {
  if (finding.fromSeq === null || finding.toSeq === null) return [];
  return repoDb.getEvidenceRange(finding.sessionId, finding.fromSeq, finding.toSeq, padding);
}

/** Session header's commit modal (05-UI.md §2.3) — bounded, sha-validated `git show` (`packages/core/src/git.ts`), never `RepoStore`. */
export function getCommitDetail(repoRoot: string, sha: string): CommitDetail | null {
  const show = showCommit(repoRoot, sha);
  if (show === null) return null;
  return { sha, show };
}
