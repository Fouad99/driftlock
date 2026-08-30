import { readFileSync } from 'node:fs';
import type {
  Adapter,
  AdapterOutput,
  Brief,
  HookEnvelope,
  InstallResult,
  NewEvent,
  RepoRef,
  TranscriptRef,
} from '@driftlock/core';
import { parseEventPayload } from '@driftlock/core';
import { parseApplyPatch } from './apply-patch.ts';
import {
  PermissionRequestPayload,
  PostCompactPayload,
  PostToolUsePayload,
  SessionEndPayload,
  SessionStartPayload,
  StopPayload,
  UserPromptSubmitPayload,
} from './hook-payloads.ts';
import { mapCodexPostToolUse } from './hook-tool-mapping.ts';
import { installCodexHooks } from './install.ts';
import { inferExitCode, isTestCommand } from './test-detect.ts';

interface SessionMetaRecord {
  type: 'session_meta';
  id: string;
  timestamp: string;
  cwd: string;
  instructions?: string;
}

interface MessageContent {
  type: string;
  text?: string;
}

interface MessagePayload {
  type: 'message';
  role: 'user' | 'assistant';
  content: MessageContent[];
}

interface ReasoningPayload {
  type: 'reasoning';
  content: MessageContent[];
}

interface FunctionCallPayload {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface FunctionCallOutputPayload {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

type ResponseItemPayload =
  | MessagePayload
  | ReasoningPayload
  | FunctionCallPayload
  | FunctionCallOutputPayload;

interface ResponseItemRecord {
  type: 'response_item';
  timestamp: string;
  payload: ResponseItemPayload;
}

interface TurnContextRecord {
  type: 'turn_context';
  timestamp: string;
}

type CodexRecord = SessionMetaRecord | ResponseItemRecord | TurnContextRecord | { type: string };

function textOf(content: MessageContent[]): string {
  return content
    .filter((c) => c.type === 'input_text' || c.type === 'output_text' || c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

/** `session_start` output built from whatever the current hook envelope has on hand (every envelope carries `session_id` + `cwd`, regardless of event). */
function sessionStartOutput(
  sessionId: string,
  cwd: string,
  ts: number,
  taskText: string | null,
): Extract<AdapterOutput, { kind: 'session_start' }> {
  return {
    kind: 'session_start',
    session: {
      id: sessionId,
      agent: 'codex',
      agentSession: sessionId,
      repoRoot: cwd,
      branch: null,
      headBefore: null,
      headAfter: null,
      startedAt: ts,
      taskText,
      tokenIn: null,
      tokenOut: null,
      costUsd: null,
      source: 'hooks',
    },
  };
}

// M2 §8.1 / M1′ §B4 — resume brief injection on SessionStart (all sources,
// per the event-mapping table). Same response shape as Claude Code's
// SessionStart (`hookSpecificOutput.additionalContext`) — Codex's hooks doc
// uses the same field for context injection.
const ADDITIONAL_CONTEXT_CHAR_LIMIT = 8000;

function formatResumeBrief(result: unknown): unknown {
  const brief = result as Brief | null;
  if (!brief) return {};
  const text =
    brief.markdown.length > ADDITIONAL_CONTEXT_CHAR_LIMIT
      ? `${brief.markdown.slice(0, ADDITIONAL_CONTEXT_CHAR_LIMIT)}…`
      : brief.markdown;
  return {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  };
}

export class CodexAdapter implements Adapter {
  readonly agent = 'codex' as const;
  readonly capabilities = { resumeInject: true, preEditVerdict: true, liveEvents: true };

  async install(repo: RepoRef): Promise<InstallResult> {
    return installCodexHooks(repo);
  }

  /**
   * M1′ §B4 — Codex event mapping. `PreToolUse`/`PreCompact` intentionally
   * emit nothing: `PreToolUse` is allow-only until M6 adds the contradiction
   * check; `PreCompact` is advisory (no `compaction_pending` event kind
   * exists) and `PostCompact` is the sole source of the real `compaction`
   * event, so a `SessionStart{source:'compact'}` does not also emit one
   * (avoids double-counting one real compaction across two hooks).
   */
  async onHook(envelope: HookEnvelope, _ctx: { repo: RepoRef }): Promise<AdapterOutput[]> {
    const ts = envelope.receivedAt;

    switch (envelope.event) {
      case 'SessionStart': {
        const parsed = SessionStartPayload.safeParse(envelope.payload);
        if (!parsed.success) return [];
        const { session_id, cwd } = parsed.data;
        return [
          sessionStartOutput(session_id, cwd, ts, null),
          {
            kind: 'request',
            type: 'resume_brief',
            sessionId: session_id,
            data: null,
            reply: formatResumeBrief,
          },
        ];
      }

      case 'UserPromptSubmit': {
        const parsed = UserPromptSubmitPayload.safeParse(envelope.payload);
        if (!parsed.success) return [];
        const { session_id, cwd, prompt } = parsed.data;
        const event = {
          sessionId: session_id,
          ts,
          ...parseEventPayload('user_turn', { text: prompt }),
        } as NewEvent;
        // §B6 lazy session open: Codex can resume a thread without a fresh
        // SessionStart (a residual process silently restores it — see
        // openai/codex#24228). getOrCreateSessionByAgentSession no-ops if
        // SessionStart already opened this session, so emitting this
        // unconditionally is safe either way.
        return [
          sessionStartOutput(session_id, cwd, ts, prompt),
          { kind: 'events', sessionId: session_id, events: [event] },
        ];
      }

      case 'PreToolUse':
        return [];

      case 'PostToolUse': {
        const parsed = PostToolUsePayload.safeParse(envelope.payload);
        if (!parsed.success) return [];
        const { session_id, tool_name, tool_input, tool_response, tool_use_id } = parsed.data;
        const events = mapCodexPostToolUse(
          tool_name,
          tool_input,
          tool_response,
          tool_use_id,
          ts,
          session_id,
        );
        if (events.length === 0) return [];
        return [{ kind: 'events', sessionId: session_id, events }];
      }

      case 'PermissionRequest': {
        const parsed = PermissionRequestPayload.safeParse(envelope.payload);
        if (!parsed.success) return [];
        const { session_id, tool_name, tool_input } = parsed.data;
        const event = {
          sessionId: session_id,
          ts,
          ...parseEventPayload('permission', {
            tool: tool_name,
            args: tool_input,
            decision: 'ask',
          }),
        } as NewEvent;
        return [{ kind: 'events', sessionId: session_id, events: [event] }];
      }

      case 'PreCompact':
        return [];

      case 'PostCompact': {
        const parsed = PostCompactPayload.safeParse(envelope.payload);
        if (!parsed.success) return [];
        const { session_id } = parsed.data;
        const event = {
          sessionId: session_id,
          ts,
          ...parseEventPayload('compaction', {}),
        } as NewEvent;
        return [{ kind: 'events', sessionId: session_id, events: [event] }];
      }

      case 'Stop': {
        const parsed = StopPayload.safeParse(envelope.payload);
        if (!parsed.success) return [];
        const { session_id, last_assistant_message } = parsed.data;
        if (!last_assistant_message || last_assistant_message.trim().length === 0) return [];
        const event = {
          sessionId: session_id,
          ts,
          ...parseEventPayload('agent_turn', { text: last_assistant_message }),
        } as NewEvent;
        // Unlike Claude Code's Stop, this is not a session end — Codex is a
        // long-running interactive session and Stop fires after every turn.
        // Only the SessionEnd hook ends the session.
        return [{ kind: 'events', sessionId: session_id, events: [event] }];
      }

      case 'SessionEnd': {
        const parsed = SessionEndPayload.safeParse(envelope.payload);
        if (!parsed.success) return [];
        const { session_id, reason } = parsed.data;
        return [{ kind: 'session_end', sessionId: session_id, reason: reason ?? 'other' }];
      }

      default:
        return [];
    }
  }

  async *parseTranscript(
    file: TranscriptRef,
    _ctx: { repo: RepoRef },
  ): AsyncIterable<AdapterOutput> {
    const lines = readFileSync(file.path, 'utf-8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    if (lines.length === 0) return;

    const meta = JSON.parse(lines[0] as string) as CodexRecord;
    if (meta.type !== 'session_meta') {
      throw new Error(`expected first record to be session_meta, got ${meta.type}`);
    }
    const sessionMeta = meta as SessionMetaRecord;
    const sessionId = sessionMeta.id;

    yield {
      kind: 'session_start',
      session: {
        id: sessionId,
        agent: 'codex',
        agentSession: sessionMeta.id,
        repoRoot: sessionMeta.cwd || file.repoRoot,
        branch: null,
        headBefore: null,
        headAfter: null,
        startedAt: Date.parse(sessionMeta.timestamp),
        taskText: sessionMeta.instructions ?? null,
        tokenIn: null,
        tokenOut: null,
        costUsd: null,
        source: 'transcript',
      },
    };

    const events: NewEvent[] = [];
    const pendingCalls = new Map<string, { name: string; args: unknown }>();

    for (let i = 1; i < lines.length; i++) {
      const record = JSON.parse(lines[i] as string) as CodexRecord;
      if (record.type === 'turn_context') continue;
      if (record.type !== 'response_item') continue;

      const item = record as ResponseItemRecord;
      const ts = Date.parse(item.timestamp);
      const payload = item.payload;

      if (payload.type === 'message') {
        const text = textOf(payload.content);
        const kind = payload.role === 'user' ? 'user_turn' : 'agent_turn';
        const parsed =
          kind === 'user_turn'
            ? parseEventPayload('user_turn', { text })
            : parseEventPayload('agent_turn', { text });
        events.push({ sessionId, ts, ...parsed } as NewEvent);
      } else if (payload.type === 'reasoning') {
        const text = textOf(payload.content);
        const parsed = parseEventPayload('agent_turn', { text, reasoning: text });
        events.push({ sessionId, ts, ...parsed } as NewEvent);
      } else if (payload.type === 'function_call') {
        let args: unknown = {};
        try {
          args = JSON.parse(payload.arguments);
        } catch {
          args = { raw: payload.arguments };
        }
        pendingCalls.set(payload.call_id, { name: payload.name, args });

        if (payload.name === 'apply_patch') {
          const input = (args as { input?: string }).input ?? '';
          const edits = parseApplyPatch(input);
          for (const edit of edits) {
            const parsed = parseEventPayload('file_edit', {
              path: edit.path,
              hunks: edit.hunks,
              callId: payload.call_id,
            });
            events.push({ sessionId, ts, ...parsed } as NewEvent);
          }
        } else if (payload.name === 'shell') {
          const command = Array.isArray((args as { command?: unknown }).command)
            ? (args as { command: string[] }).command.join(' ')
            : String((args as { command?: unknown }).command ?? '');
          const parsed = parseEventPayload('tool_call', {
            callId: payload.call_id,
            name: 'shell',
            args: { command },
          });
          events.push({ sessionId, ts, ...parsed } as NewEvent);
        } else {
          const parsed = parseEventPayload('tool_call', {
            callId: payload.call_id,
            name: payload.name,
            args,
          });
          events.push({ sessionId, ts, ...parsed } as NewEvent);
        }
      } else if (payload.type === 'function_call_output') {
        const call = pendingCalls.get(payload.call_id);
        pendingCalls.delete(payload.call_id);

        if (call?.name === 'shell') {
          const command = Array.isArray((call.args as { command?: unknown }).command)
            ? (call.args as { command: string[] }).command.join(' ')
            : String((call.args as { command?: unknown }).command ?? '');
          if (isTestCommand(command)) {
            const parsed = parseEventPayload('test_run', {
              command,
              exitCode: inferExitCode(payload.output),
              summary: payload.output,
              callId: payload.call_id,
            });
            events.push({ sessionId, ts, ...parsed } as NewEvent);
            continue;
          }
        }

        const parsed = parseEventPayload('tool_result', {
          callId: payload.call_id,
          ok: inferExitCode(payload.output) === 0,
          output: payload.output,
        });
        events.push({ sessionId, ts, ...parsed } as NewEvent);
      }
    }

    yield { kind: 'events', sessionId, events };
    yield { kind: 'session_end', sessionId, reason: 'stop' };
  }
}
