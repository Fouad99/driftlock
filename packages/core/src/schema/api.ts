import { z } from 'zod';
import type { Event, EventKind } from './event.ts';
import { AgentIdSchema } from './session.ts';

// M3 (05-UI.md §4.2) — DTO shapes shared by the daemon's `/api/*` routes and
// the CLI's `--json` output, so the two can't independently drift into two
// different APIs (05-UI.md: "the HTTP layer is a transport, not a second
// API"). Both call the same query/mutation services in
// `packages/daemon/src/queries.ts` / `mutations.ts`, which return these
// types.

export const GitStatusSchema = z.enum(['clean', 'dirty', 'unavailable']);

// --- Overview ---

export const RepoRowSchema = z.object({
  repoId: z.string(),
  root: z.string(),
  name: z.string().nullable(),
  agents: z.array(AgentIdSchema),
  latestSessionId: z.string().nullable(),
  latestSessionAt: z.number().int().nullable(),
  latestSessionAgent: AgentIdSchema.nullable(),
  openFindings: z.object({
    info: z.number().int(),
    warn: z.number().int(),
    high: z.number().int(),
  }),
  branch: z.string().nullable(),
  gitStatus: GitStatusSchema,
  /** 14 entries, oldest first, one per calendar day, zero-filled — bucketed by the *session's* `startedAt` day, not `findings.created_at` (05-UI.md §2.1). */
  findingSparkline: z.array(z.object({ day: z.string(), count: z.number().int() })),
});
export type RepoRow = z.infer<typeof RepoRowSchema>;

// --- Session / event summaries ---

/** One line per row for the virtualized timeline — never the full payload (05-UI.md §4.2). */
export const EventSummarySchema = z.object({
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  ts: z.number().int(),
  kind: z.string(),
  summary: z.string(),
});
export type EventSummary = z.infer<typeof EventSummarySchema>;

export const EventPageSchema = z.object({
  events: z.array(EventSummarySchema),
  nextFrom: z.number().int().nullable(),
  maxSeq: z.number().int(),
});
export type EventPage = z.infer<typeof EventPageSchema>;

/** One-line description of an event for the timeline row — kept out of the DB so summary formatting can change without a migration. */
export function summarizeEvent(event: Pick<Event, 'kind' | 'payload'>): string {
  const p = event.payload as Record<string, unknown>;
  switch (event.kind as EventKind) {
    case 'user_turn':
      return truncateLine(String(p.text ?? ''));
    case 'agent_turn':
      return truncateLine(String(p.text ?? ''));
    case 'tool_call':
      return String(p.name ?? 'tool call');
    case 'tool_result':
      return p.ok ? 'ok' : 'failed';
    case 'file_edit':
      return String(p.path ?? '');
    case 'file_read':
      return String(p.path ?? '');
    case 'test_run':
      return `${p.command ?? ''} (exit ${p.exitCode ?? '?'})`;
    case 'compaction':
      return 'compaction';
    case 'permission':
      return `${p.tool ?? ''} · ${p.decision ?? ''}`;
    case 'subagent':
      return String(p.task ?? 'subagent');
    case 'plan_item':
      return truncateLine(String(p.text ?? ''));
    case 'session_end':
      return String(p.reason ?? 'session end');
    default:
      return event.kind;
  }
}

function truncateLine(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

// --- Commit detail ---

export const CommitDetailSchema = z.object({
  sha: z.string(),
  show: z.string(),
});
export type CommitDetail = z.infer<typeof CommitDetailSchema>;

// --- SSE ---

export const SseEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('repo_updated'), repoId: z.string() }),
  z.object({ type: z.literal('session_updated'), repoId: z.string(), sessionId: z.string() }),
  z.object({
    type: z.literal('finding_added'),
    repoId: z.string(),
    sessionId: z.string(),
    findingId: z.string(),
  }),
  z.object({ type: z.literal('heartbeat') }),
]);
export type SseEvent = z.infer<typeof SseEventSchema>;
