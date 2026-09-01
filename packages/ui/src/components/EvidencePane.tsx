import type { Event, Finding } from '@driftlock/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getEvent, getEvidence, resolveFinding, setFindingPinned } from '../api.ts';

interface EvidencePaneProps {
  repoId: string;
  sessionId: string;
  selectedSeq: number | null;
  selectedFinding: Finding | null;
  onJumpToSeq: (seq: number) => void;
}

// 05-UI.md §2.3 — evidence pane: shows the selected event's full payload,
// or the selected finding's detail with its evidence range and actions.
export function EvidencePane({
  repoId,
  sessionId,
  selectedSeq,
  selectedFinding,
  onJumpToSeq,
}: EvidencePaneProps) {
  const queryClient = useQueryClient();

  if (selectedFinding) {
    return (
      <FindingDetail
        repoId={repoId}
        sessionId={sessionId}
        finding={selectedFinding}
        onJumpToSeq={onJumpToSeq}
        onChanged={() => {
          queryClient.invalidateQueries({ queryKey: ['session', repoId, sessionId] });
        }}
      />
    );
  }

  if (selectedSeq === null) {
    return <p className="p-4 text-sm text-neutral-500">Select an event or finding.</p>;
  }

  return <EventDetail repoId={repoId} sessionId={sessionId} seq={selectedSeq} />;
}

function EventDetail({
  repoId,
  sessionId,
  seq,
}: { repoId: string; sessionId: string; seq: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['event', repoId, sessionId, seq],
    queryFn: () => getEvent(repoId, sessionId, seq),
  });

  if (isLoading) return <p className="p-4 text-sm text-neutral-500">Loading…</p>;
  if (!data) return null;
  return (
    <div className="p-4">
      <div className="mb-2 text-xs text-neutral-500">
        seq {(data as Event).seq} · {(data as Event).kind}
      </div>
      <pre className="whitespace-pre-wrap break-words text-xs">
        {JSON.stringify((data as Event).payload, null, 2)}
      </pre>
    </div>
  );
}

function FindingDetail({
  repoId,
  sessionId,
  finding,
  onJumpToSeq,
  onChanged,
}: {
  repoId: string;
  sessionId: string;
  finding: Finding;
  onJumpToSeq: (seq: number) => void;
  onChanged: () => void;
}) {
  const { data: evidence } = useQuery({
    queryKey: ['evidence', repoId, sessionId, finding.id],
    queryFn: () => getEvidence(repoId, sessionId, finding.id),
    enabled: finding.fromSeq !== null,
  });

  return (
    <div className="p-4">
      <div className="mb-1 text-xs uppercase text-neutral-500">{finding.severity}</div>
      <h3 className="mb-1 font-medium">{finding.title}</h3>
      <p className="mb-3 text-sm text-neutral-600 dark:text-neutral-400">{finding.explanation}</p>

      <div className="mb-3 flex gap-2">
        <button
          type="button"
          disabled={finding.resolvedAt !== null}
          onClick={async () => {
            await resolveFinding(repoId, finding.id);
            onChanged();
          }}
          className="rounded border border-neutral-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-neutral-700"
        >
          {finding.resolvedAt !== null ? 'resolved' : 'mark resolved'}
        </button>
        <button
          type="button"
          onClick={async () => {
            await setFindingPinned(repoId, finding.id, !finding.pinned);
            onChanged();
          }}
          className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
        >
          {finding.pinned ? 'remove from brief' : 'add to brief'}
        </button>
        {finding.fromSeq !== null && (
          <button
            type="button"
            onClick={() => onJumpToSeq(finding.fromSeq as number)}
            className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
          >
            open in timeline
          </button>
        )}
      </div>

      {evidence && evidence.events.length > 0 && (
        <div>
          <div className="mb-1 text-xs uppercase text-neutral-500">Evidence</div>
          <ul className="space-y-1 text-xs">
            {evidence.events.map((e) => (
              <li key={e.seq} className="font-mono">
                [{e.seq}] {e.kind} — {e.summary}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
