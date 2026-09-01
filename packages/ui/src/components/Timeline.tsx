import type { Finding } from '@driftlock/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef } from 'react';
import type { EventPageQuery } from '../api.ts';
import { formatRelativeTime } from '../format.ts';

const FILTERS: { value: EventPageQuery['filter']; label: string }[] = [
  { value: 'all', label: 'all' },
  { value: 'edits', label: 'edits' },
  { value: 'tests', label: 'tests' },
  { value: 'reads', label: 'reads' },
  { value: 'findings', label: 'findings' },
];

interface TimelineEvent {
  seq: number;
  ts: number;
  kind: string;
  summary: string;
}

interface TimelineProps {
  events: TimelineEvent[];
  findings: Finding[];
  maxSeq: number;
  filter: EventPageQuery['filter'];
  onFilterChange: (filter: EventPageQuery['filter']) => void;
  selectedSeq: number | null;
  onSelectSeq: (seq: number) => void;
  onSelectFinding: (finding: Finding) => void;
}

function findingsCoveringSeq(findings: Finding[], seq: number): Finding[] {
  return findings.filter(
    (f) => f.fromSeq !== null && f.toSeq !== null && seq >= f.fromSeq && seq <= f.toSeq,
  );
}

// 05-UI.md §2.3 — the timeline: virtualized (TanStack Virtual — handles
// 10,000 events without jank per §4.4), finding badges inline on their
// evidence rows, compaction breaks, filter chips, `j`/`k`/`f`/`enter`.
export function Timeline({
  events,
  findings,
  maxSeq,
  filter,
  onFilterChange,
  selectedSeq,
  onSelectSeq,
  onSelectFinding,
}: TimelineProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 20,
  });

  const selectedIndex = useMemo(
    () => events.findIndex((e) => e.seq === selectedSeq),
    [events, selectedSeq],
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (events.length === 0) return;
      if (e.key === 'j' || e.key === 'k') {
        const delta = e.key === 'j' ? 1 : -1;
        const nextIndex = Math.min(
          events.length - 1,
          Math.max(0, (selectedIndex === -1 ? 0 : selectedIndex) + delta),
        );
        const next = events[nextIndex];
        if (next) {
          onSelectSeq(next.seq);
          rowVirtualizer.scrollToIndex(nextIndex);
        }
      } else if (e.key === 'f') {
        const open = findings.filter((f) => f.resolvedAt === null && f.fromSeq !== null);
        const next = open.find((f) => (f.fromSeq as number) > (selectedSeq ?? -1)) ?? open[0];
        if (next) onSelectFinding(next);
      } else if (e.key === 'Enter' && selectedIndex !== -1) {
        const ev = events[selectedIndex];
        if (ev) onSelectSeq(ev.seq);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [events, selectedIndex, selectedSeq, findings, onSelectSeq, onSelectFinding, rowVirtualizer]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 border-b border-neutral-200 p-2 dark:border-neutral-800">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => onFilterChange(f.value)}
            className={`rounded px-2 py-1 text-xs ${
              filter === f.value
                ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div ref={parentRef} className="flex-1 overflow-auto">
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const event = events[virtualRow.index] as TimelineEvent;
            const isCompaction = event.kind === 'compaction';
            const isSubagent = event.kind === 'subagent';
            const covering = findingsCoveringSeq(findings, event.seq);
            const isSelected = event.seq === selectedSeq;

            if (isCompaction) {
              return (
                <div
                  key={event.seq}
                  style={{
                    position: 'absolute',
                    top: virtualRow.start,
                    height: virtualRow.size,
                    width: '100%',
                  }}
                  className="flex items-center px-3"
                >
                  <div className="h-px flex-1 border-t border-dashed border-neutral-300 dark:border-neutral-700" />
                  <span className="px-2 text-xs text-neutral-400">
                    compaction · {maxSeq > 0 ? Math.round((event.seq / maxSeq) * 100) : 0}%
                  </span>
                  <div className="h-px flex-1 border-t border-dashed border-neutral-300 dark:border-neutral-700" />
                </div>
              );
            }

            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav is global (j/k/f/enter), not per-row
              <div
                key={event.seq}
                onClick={() => onSelectSeq(event.seq)}
                style={{
                  position: 'absolute',
                  top: virtualRow.start,
                  height: virtualRow.size,
                  width: '100%',
                }}
                className={`flex cursor-pointer items-center gap-2 px-3 text-xs ${
                  isSelected
                    ? 'bg-blue-50 dark:bg-blue-950'
                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-900'
                } ${isSubagent ? 'pl-8 italic text-neutral-500' : ''}`}
              >
                <span className="w-10 shrink-0 text-neutral-400">{event.seq}</span>
                <span className="w-16 shrink-0 text-neutral-400">{event.kind}</span>
                <span className="flex-1 truncate">{event.summary}</span>
                <span className="w-14 shrink-0 text-right text-neutral-400">
                  {formatRelativeTime(event.ts)}
                </span>
                {covering.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectFinding(f);
                    }}
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                      f.severity === 'high'
                        ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                        : f.severity === 'warn'
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                          : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                    }`}
                  >
                    {f.analyzer}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
