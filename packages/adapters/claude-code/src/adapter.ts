import type {
  Adapter,
  AdapterOutput,
  HookEnvelope,
  InstallResult,
  NewEvent,
  RepoRef,
} from '@driftlock/core';
import { parseEventPayload } from '@driftlock/core';
import {
  PostToolUsePayload,
  PreCompactPayload,
  SessionStartPayload,
  StopPayload,
  UserPromptSubmitPayload,
} from './hook-payloads.ts';
import { installClaudeCodeHooks } from './install.ts';
import { mapPostToolUse } from './tool-mapping.ts';

// Architecture doc §4.3, per-agent table — Claude Code column. `parseTranscript`
// isn't implemented: unlike Codex, there's no reliable, documented transcript
// format to fall back on (the hooks doc explicitly says the transcript file
// "is written asynchronously and may lag" and to prefer `last_assistant_message`
// on Stop instead — so that's what this adapter does).
export class ClaudeCodeAdapter implements Adapter {
  readonly agent = 'claude-code' as const;
  readonly capabilities = { resumeInject: true, preEditVerdict: true, liveEvents: true };

  async install(repo: RepoRef): Promise<InstallResult> {
    return installClaudeCodeHooks(repo);
  }

  async onHook(envelope: HookEnvelope, _ctx: { repo: RepoRef }): Promise<AdapterOutput[]> {
    const ts = envelope.receivedAt;

    switch (envelope.event) {
      case 'SessionStart': {
        const parsed = SessionStartPayload.safeParse(envelope.payload);
        if (!parsed.success) return [];
        const { session_id, cwd } = parsed.data;
        return [
          {
            kind: 'session_start',
            session: {
              id: session_id,
              agent: 'claude-code',
              agentSession: session_id,
              repoRoot: cwd,
              branch: null,
              headBefore: null,
              headAfter: null,
              startedAt: ts,
              taskText: null,
              tokenIn: null,
              tokenOut: null,
              costUsd: null,
              source: 'hooks',
            },
          },
        ];
      }

      case 'UserPromptSubmit': {
        const parsed = UserPromptSubmitPayload.safeParse(envelope.payload);
        if (!parsed.success) return [];
        const { session_id, user_prompt } = parsed.data;
        const event = {
          sessionId: session_id,
          ts,
          ...parseEventPayload('user_turn', { text: user_prompt }),
        } as NewEvent;
        return [{ kind: 'events', sessionId: session_id, events: [event] }];
      }

      case 'PostToolUse': {
        const parsed = PostToolUsePayload.safeParse(envelope.payload);
        if (!parsed.success) return [];
        const { session_id, tool_name, tool_input, tool_output, tool_use_id } = parsed.data;
        const events = mapPostToolUse(
          tool_name,
          tool_input,
          tool_output,
          tool_use_id,
          ts,
          session_id,
        );
        return [{ kind: 'events', sessionId: session_id, events }];
      }

      case 'PreCompact': {
        const parsed = PreCompactPayload.safeParse(envelope.payload);
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
        const outputs: AdapterOutput[] = [];
        if (last_assistant_message && last_assistant_message.trim().length > 0) {
          const event = {
            sessionId: session_id,
            ts,
            ...parseEventPayload('agent_turn', { text: last_assistant_message }),
          } as NewEvent;
          outputs.push({ kind: 'events', sessionId: session_id, events: [event] });
        }
        outputs.push({ kind: 'session_end', sessionId: session_id, reason: 'stop' });
        return outputs;
      }

      default:
        return [];
    }
  }
}
