import type { z } from 'zod';
import type { NewEvent } from '../schema/event.ts';
import type { AgentId, SessionInit } from '../schema/session.ts';

// Architecture doc §4.3 — Adapter contract.

export interface HookEnvelope {
  // Client-generated (crypto.randomUUID()) once per hook invocation — lets
  // the daemon dedupe a request that was delivered live but then replayed
  // via the spool because the client couldn't confirm delivery before its
  // own timeout (architecture doc §4.1's request-response timeout budget).
  id: string;
  agent: AgentId;
  event: string;
  cwd: string;
  receivedAt: number;
  payload: unknown;
}

export interface RepoRef {
  root: string;
  repoId: string;
}

export interface TranscriptRef {
  path: string;
  repoRoot: string;
}

export type AdapterOutput =
  | { kind: 'session_start'; session: SessionInit }
  | { kind: 'events'; sessionId: string; events: NewEvent[] }
  | { kind: 'session_end'; sessionId: string; reason: string }
  | {
      kind: 'request';
      type: 'resume_brief' | 'pre_edit_verdict';
      sessionId: string;
      data: unknown;
      // Called by the daemon (which owns the store this adapter's `onHook`
      // never gets) with the answer — a `Brief | null` for `resume_brief`,
      // a verdict for `pre_edit_verdict` (M6). Returns the adapter-specific
      // JSON shape to merge into the hook's HTTP/stdout response (e.g.
      // Claude Code's `{ hookSpecificOutput: { additionalContext } }`) — the
      // formatting is the adapter's job since it's the one that knows its
      // own agent's hook response contract.
      reply: (result: unknown) => unknown;
    };

export interface AdapterCapabilities {
  resumeInject: boolean;
  preEditVerdict: boolean;
  liveEvents: boolean;
}

export interface InstallResult {
  installed: boolean;
  details: string;
}

export interface AdapterContext {
  repo: RepoRef;
}

export interface Adapter {
  readonly agent: AgentId;
  readonly capabilities: AdapterCapabilities;
  // Array, not a single value: one hook payload can translate into more than
  // one thing (e.g. Claude Code's `Stop` both delivers the final assistant
  // turn as an `events` output and ends the session as a `session_end`
  // output) — see architecture doc §4.3's own note that a hook payload maps
  // to "zero or more events".
  onHook?(envelope: HookEnvelope, ctx: AdapterContext): Promise<AdapterOutput[]>;
  parseTranscript?(file: TranscriptRef, ctx: AdapterContext): AsyncIterable<AdapterOutput>;
  install(repo: RepoRef): Promise<InstallResult>;
}

// Re-exported so adapters can validate freeform hook JSON without importing zod directly.
export type ZodSchema<T> = z.ZodType<T>;
