import type { z } from 'zod';
import { pathKey } from '../paths.ts';
import type { NewEvent } from '../schema/event.ts';
import type {
  FileEditPayload,
  TestRunPayload,
  ToolCallPayload,
  ToolResultPayload,
} from '../schema/event.ts';

type FileEdit = z.infer<typeof FileEditPayload>;
type TestRun = z.infer<typeof TestRunPayload>;
type ToolCall = z.infer<typeof ToolCallPayload>;
type ToolResult = z.infer<typeof ToolResultPayload>;

// M1' reconciliation design — Codex's hook and transcript ingestion paths
// can both describe the same real occurrence (the same tool call, the same
// assistant turn). This fingerprint lets the transcript merge path
// (`RepoStore.mergeEvents`) recognize "already represented by a hook event"
// without a fragile ts±N match alone, and lets the hook write path
// (`RepoStore.appendEvents`) protect itself from duplicate delivery too.
//
// `null` means "no safe key" — the event is always inserted, never matched
// against another. That's a deliberate, documented gap for kinds with no
// natural identity (`permission`, `subagent`, `plan_item`, `session_end`,
// `raw`) rather than a broad, collision-prone match.

const BUCKET_MS = 30_000;

/** 30s buckets absorb clock skew between a hook firing and Codex flushing the transcript record, without collapsing genuinely repeated messages sent minutes apart. */
export function eventTimeBucket(ts: number): number {
  return Math.floor(ts / BUCKET_MS);
}

function hashText(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return Bun.hash(normalized).toString(36);
}

/**
 * Deterministic dedupe key for an event. Stable-id kinds (a shared
 * `tool_use_id` / transcript `call_id`, carried in the payload as `callId`)
 * key on `call:<kind>:<id>` — exact match, no time bucket. `kind` is part
 * of the key because one call can produce more than one event kind
 * (`tool_call` + `tool_result`); for `file_edit`, the touched path is also
 * included because one `apply_patch` call can touch several files, one
 * `file_edit` event each.
 *
 * Kinds with no stable id fall back to a content-hash + time-bucket key.
 * `agent_turn`/`user_turn` deliberately are NOT exempted here even though a
 * hook-truncated `agent_turn` and its fuller transcript counterpart hash
 * differently (see `RepoStore.mergeEvents`'s prefix-enrichment exception,
 * which handles that case with its own bucket-adjacent lookup — this
 * function only ever reports exact-content matches).
 */
export function fingerprintEvent(event: Pick<NewEvent, 'kind' | 'ts' | 'payload'>): string | null {
  switch (event.kind) {
    case 'tool_call':
      return `call:tool_call:${(event.payload as ToolCall).callId}`;
    case 'tool_result':
      return `call:tool_result:${(event.payload as ToolResult).callId}`;
    case 'file_edit': {
      const p = event.payload as FileEdit;
      const path = pathKey(p.path);
      return p.callId
        ? `call:file_edit:${p.callId}:${path}`
        : `file_edit:${path}:${eventTimeBucket(event.ts)}`;
    }
    case 'test_run': {
      const p = event.payload as TestRun;
      return p.callId
        ? `call:test_run:${p.callId}`
        : `test_run:${hashText(p.command)}:${eventTimeBucket(event.ts)}`;
    }
    case 'user_turn':
    case 'agent_turn':
      return `${event.kind}:${hashText((event.payload as { text: string }).text)}:${eventTimeBucket(event.ts)}`;
    case 'compaction':
      return `compaction:${eventTimeBucket(event.ts)}`;
    default:
      return null;
  }
}
