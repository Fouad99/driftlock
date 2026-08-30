import { describe, expect, test } from 'bun:test';
import type { HookEnvelope, RepoRef } from '@driftlock/core';
import { ClaudeCodeAdapter } from '../src/adapter.ts';

const adapter = new ClaudeCodeAdapter();
const repo: RepoRef = { root: '/repo', repoId: 'r1' };
const ctx = { repo };

function envelope(event: string, payload: unknown): HookEnvelope {
  return {
    id: 'test-envelope',
    agent: 'claude-code',
    event,
    cwd: '/repo',
    receivedAt: 1000,
    payload,
  };
}

describe('ClaudeCodeAdapter.onHook — SessionStart', () => {
  test('emits a session_start with the claude session_id as the driftlock session id', async () => {
    const outputs = await adapter.onHook(
      envelope('SessionStart', {
        session_id: 'claude-sess-1',
        cwd: '/repo',
        hook_event_name: 'SessionStart',
      }),
      ctx,
    );
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.kind).toBe('session_start');
    if (outputs[0]?.kind !== 'session_start') throw new Error('unreachable');
    expect(outputs[0].session.id).toBe('claude-sess-1');
    expect(outputs[0].session.agentSession).toBe('claude-sess-1');
    expect(outputs[0].session.agent).toBe('claude-code');
    expect(outputs[0].session.source).toBe('hooks');

    expect(outputs[1]?.kind).toBe('request');
    if (outputs[1]?.kind !== 'request') throw new Error('unreachable');
    expect(outputs[1].type).toBe('resume_brief');
    expect(outputs[1].sessionId).toBe('claude-sess-1');
  });

  test('resume_brief reply formats a brief as Claude Code additionalContext', async () => {
    const outputs = await adapter.onHook(
      envelope('SessionStart', {
        session_id: 'claude-sess-1',
        cwd: '/repo',
        hook_event_name: 'SessionStart',
      }),
      ctx,
    );
    const request = outputs.find((o) => o.kind === 'request');
    if (request?.kind !== 'request') throw new Error('unreachable');

    const withBrief = request.reply({
      sessionId: 'claude-sess-1',
      generatedAt: 1000,
      markdown: '# Resume brief\nhello',
    }) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(withBrief.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(withBrief.hookSpecificOutput.additionalContext).toContain('hello');

    expect(request.reply(null)).toEqual({});
  });

  test('returns nothing for a malformed payload rather than throwing', async () => {
    const outputs = await adapter.onHook(envelope('SessionStart', { not: 'valid' }), ctx);
    expect(outputs).toEqual([]);
  });
});

describe('ClaudeCodeAdapter.onHook — UserPromptSubmit', () => {
  test('emits a user_turn event', async () => {
    const outputs = await adapter.onHook(
      envelope('UserPromptSubmit', {
        session_id: 'claude-sess-1',
        cwd: '/repo',
        hook_event_name: 'UserPromptSubmit',
        user_prompt: 'fix the bug',
      }),
      ctx,
    );
    expect(outputs).toHaveLength(1);
    if (outputs[0]?.kind !== 'events') throw new Error('unreachable');
    expect(outputs[0].sessionId).toBe('claude-sess-1');
    expect(outputs[0].events[0]?.kind).toBe('user_turn');
  });
});

describe('ClaudeCodeAdapter.onHook — PostToolUse', () => {
  test('emits the mapped tool events', async () => {
    const outputs = await adapter.onHook(
      envelope('PostToolUse', {
        session_id: 'claude-sess-1',
        cwd: '/repo',
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
        tool_output: { ok: true },
      }),
      ctx,
    );
    expect(outputs).toHaveLength(1);
    if (outputs[0]?.kind !== 'events') throw new Error('unreachable');
    expect(outputs[0].events[0]?.kind).toBe('file_edit');
  });
});

describe('ClaudeCodeAdapter.onHook — PreCompact', () => {
  test('emits a compaction event', async () => {
    const outputs = await adapter.onHook(
      envelope('PreCompact', {
        session_id: 'claude-sess-1',
        cwd: '/repo',
        hook_event_name: 'PreCompact',
        trigger: 'auto',
      }),
      ctx,
    );
    expect(outputs).toHaveLength(1);
    if (outputs[0]?.kind !== 'events') throw new Error('unreachable');
    expect(outputs[0].events[0]?.kind).toBe('compaction');
  });
});

describe('ClaudeCodeAdapter.onHook — Stop', () => {
  test('emits both the final agent_turn and session_end when last_assistant_message is present', async () => {
    const outputs = await adapter.onHook(
      envelope('Stop', {
        session_id: 'claude-sess-1',
        cwd: '/repo',
        hook_event_name: 'Stop',
        last_assistant_message: 'Done, tests pass.',
      }),
      ctx,
    );
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.kind).toBe('events');
    if (outputs[0]?.kind !== 'events') throw new Error('unreachable');
    expect(outputs[0].events[0]?.kind).toBe('agent_turn');
    expect(outputs[1]?.kind).toBe('session_end');
  });

  test('emits only session_end when there is no last_assistant_message', async () => {
    const outputs = await adapter.onHook(
      envelope('Stop', { session_id: 'claude-sess-1', cwd: '/repo', hook_event_name: 'Stop' }),
      ctx,
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.kind).toBe('session_end');
  });
});

describe('ClaudeCodeAdapter.onHook — unrecognized event', () => {
  test('returns nothing', async () => {
    const outputs = await adapter.onHook(envelope('SomeFutureEvent', {}), ctx);
    expect(outputs).toEqual([]);
  });
});
