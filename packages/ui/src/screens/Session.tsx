import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { type EventPageQuery, getEventPage, getSessionDetail } from '../api.ts';
import { CommitModal } from '../components/CommitModal.tsx';
import { EvidencePane } from '../components/EvidencePane.tsx';
import { Timeline } from '../components/Timeline.tsx';
import { formatDuration } from '../format.ts';

interface EventRow {
  seq: number;
  ts: number;
  kind: string;
  summary: string;
}

/**
 * Loads every page of event *summaries* (never full payloads — those load
 * on selection, see `EvidencePane`) up front so the timeline can virtualize
 * over a plain array. Summaries are small (seq/ts/kind/one-line string), so
 * holding all of them for a 10,000-event session is cheap; this is a
 * simplification of "paginated by seq" (05-UI.md §4.4) — load-once instead
 * of load-per-scroll — that can be swapped for incremental loading later
 * without an API change.
 *
 * Query key is `['session', repoId, sessionId, 'events', filter]` —
 * deliberately nested under the same `['session', repoId, sessionId]`
 * prefix `useLiveUpdates` invalidates on `session_updated`/`finding_added`
 * SSE events (TanStack Query's default `invalidateQueries` matches by
 * prefix), so a live-in-progress session's timeline actually refreshes
 * instead of only the finding/brief data updating underneath it.
 */
async function loadAllEvents(
  repoId: string,
  sessionId: string,
  filter: EventPageQuery['filter'],
): Promise<{ events: EventRow[]; maxSeq: number }> {
  let fromSeq: number | undefined;
  const all: EventRow[] = [];
  let maxSeq = 0;
  for (;;) {
    const page = await getEventPage(repoId, sessionId, {
      ...(fromSeq !== undefined && { fromSeq }),
      limit: 500,
      ...(filter && { filter }),
    });
    all.push(...page.events);
    maxSeq = page.maxSeq;
    if (page.nextFrom === null) break;
    fromSeq = page.nextFrom;
  }
  return { events: all, maxSeq };
}

export function SessionScreen() {
  const { repoId, sessionId } = useParams<{ repoId: string; sessionId: string }>();
  const [filter, setFilter] = useState<EventPageQuery['filter']>('all');
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [openCommitSha, setOpenCommitSha] = useState<string | null>(null);

  const { data: detail } = useQuery({
    queryKey: ['session', repoId, sessionId],
    queryFn: () => getSessionDetail(repoId as string, sessionId as string),
    enabled: Boolean(repoId && sessionId),
  });

  const { data: eventData, isLoading: eventsLoading } = useQuery({
    queryKey: ['session', repoId, sessionId, 'events', filter],
    queryFn: () => loadAllEvents(repoId as string, sessionId as string, filter),
    enabled: Boolean(repoId && sessionId),
  });

  if (!repoId || !sessionId) return null;

  const events = eventData?.events ?? [];
  const maxSeq = eventData?.maxSeq ?? 0;
  const findings = detail?.findings ?? [];
  // Derived from the live `findings` query result by id, not stored as its
  // own object — otherwise the pane keeps rendering a stale finding (wrong
  // resolved/pinned state, and a "mark resolved" click could resend the
  // same mutation) after a mutation invalidates and refetches `findings`.
  const selectedFinding = findings.find((f) => f.id === selectedFindingId) ?? null;
  const findingCounts = findings.reduce(
    (acc, f) => {
      if (f.resolvedAt === null) acc[f.severity] += 1;
      return acc;
    },
    { info: 0, warn: 0, high: 0 } as Record<'info' | 'warn' | 'high', number>,
  );

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b border-neutral-200 p-3 text-sm dark:border-neutral-800">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{detail?.session.agent ?? '…'}</span>
          <span className="text-neutral-500">{detail?.session.branch ?? '(no branch)'}</span>
          <span className="text-neutral-500">
            {detail && formatDuration(detail.session.startedAt, detail.session.endedAt)}
          </span>
          {detail && detail.compactionCount > 0 && (
            <span className="text-neutral-500">
              {detail.compactionCount} compaction{detail.compactionCount === 1 ? '' : 's'}
            </span>
          )}
          <span className="text-red-600">
            {findingCounts.high > 0 && `${findingCounts.high} high`}
          </span>
          <span className="text-amber-600">
            {findingCounts.warn > 0 && `${findingCounts.warn} warn`}
          </span>
          {detail && detail.linkedCommits.length > 0 && (
            <span className="flex items-center gap-1 text-neutral-500">
              commits:
              {detail.linkedCommits.map((sha) => (
                <button
                  key={sha}
                  type="button"
                  onClick={() => setOpenCommitSha(sha)}
                  className="rounded border border-neutral-300 px-1 font-mono text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
                >
                  {sha.slice(0, 7)}
                </button>
              ))}
            </span>
          )}
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <div className="w-2/3 border-r border-neutral-200 dark:border-neutral-800">
          {eventsLoading && events.length === 0 ? (
            <p className="p-4 text-sm text-neutral-500">Loading timeline…</p>
          ) : (
            <Timeline
              events={events}
              findings={findings}
              maxSeq={maxSeq}
              filter={filter}
              onFilterChange={setFilter}
              selectedSeq={selectedSeq}
              onSelectSeq={(seq) => {
                setSelectedSeq(seq);
                setSelectedFindingId(null);
              }}
              onSelectFinding={(finding) => {
                setSelectedFindingId(finding.id);
                setSelectedSeq(null);
              }}
            />
          )}
        </div>
        <div className="w-1/3 overflow-auto">
          <EvidencePane
            repoId={repoId}
            sessionId={sessionId}
            selectedSeq={selectedSeq}
            selectedFinding={selectedFinding}
            onJumpToSeq={(seq) => {
              setSelectedSeq(seq);
              setSelectedFindingId(null);
            }}
          />
        </div>
      </div>
      {openCommitSha && (
        <CommitModal repoId={repoId} sha={openCommitSha} onClose={() => setOpenCommitSha(null)} />
      )}
    </div>
  );
}
