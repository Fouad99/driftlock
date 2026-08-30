import { readFileSync } from 'node:fs';
import type {
  Adapter,
  AdapterOutput,
  InstallResult,
  NewEvent,
  RepoRef,
  TranscriptRef,
} from '@driftlock/core';
import { parseEventPayload } from '@driftlock/core';
import { parseApplyPatch } from './apply-patch.ts';
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

export class CodexAdapter implements Adapter {
  readonly agent = 'codex' as const;
  readonly capabilities = { resumeInject: false, preEditVerdict: false, liveEvents: false };

  async install(_repo: RepoRef): Promise<InstallResult> {
    // Real ~/.codex/config.toml `notify` wiring and transcript-dir registration
    // land with `driftlock init` (M1 step 2) using the daemon's registry.
    return {
      installed: false,
      details: 'codex install is wired by `driftlock init`, not the adapter directly',
    };
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
