import type { z } from 'zod';
import type { NewEvent } from '../schema/event.ts';
import type { AgentId, SessionInit } from '../schema/session.ts';

// Architecture doc §4.3 — Adapter contract.

export interface HookEnvelope {
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
      reply: (r: unknown) => void;
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
  onHook?(envelope: HookEnvelope, ctx: AdapterContext): Promise<AdapterOutput>;
  parseTranscript?(file: TranscriptRef, ctx: AdapterContext): AsyncIterable<AdapterOutput>;
  install(repo: RepoRef): Promise<InstallResult>;
}

// Re-exported so adapters can validate freeform hook JSON without importing zod directly.
export type ZodSchema<T> = z.ZodType<T>;
