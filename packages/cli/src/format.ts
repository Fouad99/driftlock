import type { Event, Finding, Session } from '@driftlock/core';
import type { DoctorCheck } from './doctor.ts';
import type { StatusRow } from './status.ts';

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function formatRelativeTime(ts: number | null): string {
  if (ts === null) return 'never';
  const diffMs = Date.now() - ts;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function formatStatus(rows: StatusRow[]): string {
  if (rows.length === 0) return 'no repos registered — run `driftlock init` in a repo first';

  const cols = { name: 16, lastSession: 14, agent: 12, findings: 15, branch: 20 };
  const header = `${pad('repo', cols.name)} ${pad('last session', cols.lastSession)} ${pad('agent', cols.agent)} ${pad('open findings', cols.findings)} branch`;
  const lines = [header];
  for (const row of rows) {
    const branch = row.branch ? `${row.branch}${row.dirty ? ' (dirty)' : ''}` : '(no branch)';
    lines.push(
      `${pad(row.name, cols.name)} ${pad(formatRelativeTime(row.lastSessionAt), cols.lastSession)} ${pad(row.agent ?? '-', cols.agent)} ${pad(String(row.openFindings), cols.findings)} ${branch}`,
    );
  }
  return lines.join('\n');
}

function formatDuration(session: Session): string {
  if (!session.endedAt) return 'in progress';
  const minutes = Math.round((session.endedAt - session.startedAt) / 60000);
  return `${minutes} min`;
}

function seqRange(f: Finding): string {
  if (f.fromSeq === null && f.toSeq === null) return '';
  if (f.fromSeq === f.toSeq) return ` (seq ${f.fromSeq})`;
  return ` (seq ${f.fromSeq}–${f.toSeq})`;
}

export function formatReport(session: Session, findings: Finding[]): string {
  const compactionCount = findings.find((f) => f.analyzer === 'compaction')?.data as
    | { count?: number }
    | undefined;
  const lines: string[] = [];
  lines.push(
    `driftlock · session ${session.id} · ${session.agent} · ${session.branch ?? '(no branch)'} · ${formatDuration(session)}${
      compactionCount?.count
        ? ` · ${compactionCount.count} compaction${compactionCount.count === 1 ? '' : 's'}`
        : ''
    }`,
  );
  lines.push('');

  if (findings.length === 0) {
    lines.push('  ok    no findings');
  } else {
    for (const f of findings) {
      lines.push(`  ${pad(f.severity, 5)} ${pad(f.analyzer, 18)} ${f.title}${seqRange(f)}`);
    }
  }

  lines.push('');
  lines.push(`  driftlock report ${session.id} --explain   for evidence`);
  return lines.join('\n');
}

const STATUS_ICON: Record<DoctorCheck['status'], string> = { ok: '✓', warn: '!', fail: '✗' };

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks.map((c) => `  ${STATUS_ICON[c.status]}  ${pad(c.name, 24)} ${c.detail}`).join('\n');
}

export function formatExplain(findings: Finding[], events: Event[]): string {
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`\n${f.severity.toUpperCase()} ${f.analyzer} — ${f.title}`);
    lines.push(f.explanation);
    if (f.fromSeq !== null && f.toSeq !== null) {
      const evidence = events.filter(
        (e) => e.seq >= (f.fromSeq as number) && e.seq <= (f.toSeq as number),
      );
      for (const e of evidence) {
        lines.push(`  [${e.seq}] ${e.kind} ${JSON.stringify(e.payload).slice(0, 120)}`);
      }
    }
  }
  return lines.join('\n');
}
