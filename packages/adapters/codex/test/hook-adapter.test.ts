import { describe, expect, test } from 'bun:test';
import type { HookEnvelope, RepoRef } from '@driftlock/core';
import { CodexAdapter } from '../src/adapter.ts';

const adapter = new CodexAdapter();
const repo: RepoRef = { root: '/repo', repoId: 'r1' };
const ctx = { repo };

function envelope(event: string, payload: unknown, receivedAt = 1000): HookEnvelope {
  return { id: 'test-envelope', agent: 'codex', event, cwd: '/repo', receivedAt, payload };
}

describe('CodexAdapter capabilities', () => {
  test('all three flip true once the hook adapter exists', () => {
    expect(adapter.capabilities).toEqual({
      resumeInject: true,
      preEditVerdict: true,
      liveEvents: true,
    });
  });
});

describe('CodexAdapter.onHook — SessionStart', () => {
  test('emits a session_start with the codex session_id as the driftlock session id', async () => {
    const outputs = await adapter.onHook(
      envelope('SessionStart', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'SessionStart',
        source: 'startup',
      }),
      ctx,
    );
    expect(outputs).toHaveLength(2);
    if (outputs[0]?.kind !== 'session_start') throw new Error('unreachable');
    expect(outputs[0].session.id).toBe('codex-sess-1');
    expect(outputs[0].session.agent).toBe('codex');
    expect(outputs[0].session.source).toBe('hooks');

    expect(outputs[1]?.kind).toBe('request');
    if (outputs[1]?.kind !== 'request') throw new Error('unreachable');
    expect(outputs[1].type).toBe('resume_brief');
    expect(outputs[1].sessionId).toBe('codex-sess-1');
  });

  test('resume_brief reply formats a brief as additionalContext', async () => {
    const outputs = await adapter.onHook(
      envelope('SessionStart', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'SessionStart',
        source: 'startup',
      }),
      ctx,
    );
    const request = outputs.find((o) => o.kind === 'request');
    if (request?.kind !== 'request') throw new Error('unreachable');

    const withBrief = request.reply({
      sessionId: 'codex-sess-1',
      generatedAt: 1000,
      markdown: '# Resume brief\nhello',
    }) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(withBrief.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(withBrief.hookSpecificOutput.additionalContext).toContain('hello');

    expect(request.reply(null)).toEqual({});
  });

  test('a compact source does not also emit a compaction event (PostCompact is the sole source)', async () => {
    const outputs = await adapter.onHook(
      envelope('SessionStart', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'SessionStart',
        source: 'compact',
      }),
      ctx,
    );
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.kind).toBe('session_start');
    expect(outputs[1]?.kind).toBe('request');
  });

  test('returns nothing for a malformed payload rather than throwing', async () => {
    const outputs = await adapter.onHook(envelope('SessionStart', { not: 'valid' }), ctx);
    expect(outputs).toEqual([]);
  });
});

describe('CodexAdapter.onHook — UserPromptSubmit (lazy session open)', () => {
  test('emits both a session_start (reuse-or-create) and a user_turn event', async () => {
    const outputs = await adapter.onHook(
      envelope('UserPromptSubmit', {
        session_id: 'codex-sess-2',
        cwd: '/repo',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'fix the bug',
      }),
      ctx,
    );
    expect(outputs).toHaveLength(2);
    if (outputs[0]?.kind !== 'session_start') throw new Error('unreachable');
    expect(outputs[0].session.id).toBe('codex-sess-2');
    expect(outputs[0].session.taskText).toBe('fix the bug');
    if (outputs[1]?.kind !== 'events') throw new Error('unreachable');
    expect(outputs[1].events[0]?.kind).toBe('user_turn');
  });
});

describe('CodexAdapter.onHook — PreToolUse', () => {
  test('stores nothing (allow-only until M6)', async () => {
    const outputs = await adapter.onHook(
      envelope('PreToolUse', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
      }),
      ctx,
    );
    expect(outputs).toEqual([]);
  });
});

describe('CodexAdapter.onHook — PostToolUse', () => {
  test('apply_patch produces tool_call, file_edit, and tool_result', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/api/login.ts',
      '@@',
      '-old line',
      '+new line',
      '*** End Patch',
    ].join('\n');
    const outputs = await adapter.onHook(
      envelope('PostToolUse', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'PostToolUse',
        tool_name: 'apply_patch',
        tool_use_id: 'call-1',
        tool_input: { command: patch },
        tool_response: { output: 'ok', exit_code: 0 },
      }),
      ctx,
    );
    expect(outputs).toHaveLength(1);
    if (outputs[0]?.kind !== 'events') throw new Error('unreachable');
    const kinds = outputs[0].events.map((e) => e.kind);
    expect(kinds).toEqual(['tool_call', 'file_edit', 'tool_result']);
    const edit = outputs[0].events.find((e) => e.kind === 'file_edit');
    if (edit?.kind !== 'file_edit') throw new Error('unreachable');
    expect(edit.payload.path).toBe('src/api/login.ts');
  });

  test('a test-matching shell command produces a test_run instead of tool_call/tool_result', async () => {
    const outputs = await adapter.onHook(
      envelope('PostToolUse', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: 'call-2',
        tool_input: { command: 'bun test' },
        tool_response: { output: 'all tests passed', exit_code: 0 },
      }),
      ctx,
    );
    if (outputs[0]?.kind !== 'events') throw new Error('unreachable');
    expect(outputs[0].events).toHaveLength(1);
    const testRun = outputs[0].events[0];
    if (testRun?.kind !== 'test_run') throw new Error('unreachable');
    expect(testRun.payload.exitCode).toBe(0);
  });

  test('a non-test shell command produces tool_call + tool_result', async () => {
    const outputs = await adapter.onHook(
      envelope('PostToolUse', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: 'call-3',
        tool_input: { command: 'ls -la' },
        tool_response: { output: 'file1\nfile2', exit_code: 0 },
      }),
      ctx,
    );
    if (outputs[0]?.kind !== 'events') throw new Error('unreachable');
    expect(outputs[0].events.map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
    const call = outputs[0].events[0];
    if (call?.kind !== 'tool_call') throw new Error('unreachable');
    expect(call.payload.name).toBe('Bash');
  });

  // Regression pin: Codex's real hook payload reports tool_name "Bash" for
  // shell/exec_command calls (codex-rs's HookToolName::bash()), not "shell"
  // — an earlier version of this adapter switched on 'shell' by mistake and
  // silently dropped every real shell PostToolUse into the generic fallback.
  test('a tool_name of "shell" (the wrong, pre-fix name) falls through to the generic mapping, not the shell-specific one', async () => {
    const outputs = await adapter.onHook(
      envelope('PostToolUse', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'PostToolUse',
        tool_name: 'shell',
        tool_use_id: 'call-x',
        tool_input: { command: 'npm test' },
        tool_response: { output: 'ok', exit_code: 0 },
      }),
      ctx,
    );
    if (outputs[0]?.kind !== 'events') throw new Error('unreachable');
    // generic mapping never detects test_run — only mapBash does
    expect(outputs[0].events.map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
    const call = outputs[0].events[0];
    if (call?.kind !== 'tool_call') throw new Error('unreachable');
    expect(call.payload.name).toBe('shell');
  });

  test('update_plan produces one plan_item per step', async () => {
    const outputs = await adapter.onHook(
      envelope('PostToolUse', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'PostToolUse',
        tool_name: 'update_plan',
        tool_use_id: 'call-4',
        tool_input: {
          plan: [
            { step: 'write the limiter', status: 'in_progress' },
            { step: 'add tests', status: 'pending' },
          ],
        },
      }),
      ctx,
    );
    if (outputs[0]?.kind !== 'events') throw new Error('unreachable');
    expect(outputs[0].events).toHaveLength(2);
    const [first, second] = outputs[0].events;
    if (first?.kind !== 'plan_item' || second?.kind !== 'plan_item') {
      throw new Error('unreachable');
    }
    expect(first.payload).toEqual({
      id: 'plan-0',
      text: 'write the limiter',
      status: 'in_progress',
    });
    expect(second.payload).toEqual({ id: 'plan-1', text: 'add tests', status: 'pending' });
  });
});

describe('CodexAdapter.onHook — PermissionRequest', () => {
  test('emits a capture-only permission event with decision ask', async () => {
    const outputs = await adapter.onHook(
      envelope('PermissionRequest', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      }),
      ctx,
    );
    if (outputs[0]?.kind !== 'events') throw new Error('unreachable');
    const perm = outputs[0].events[0];
    if (perm?.kind !== 'permission') throw new Error('unreachable');
    expect(perm.payload.decision).toBe('ask');
  });
});

describe('CodexAdapter.onHook — PreCompact / PostCompact', () => {
  test('PreCompact emits nothing (advisory only)', async () => {
    const outputs = await adapter.onHook(
      envelope('PreCompact', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'PreCompact',
        trigger: 'auto',
      }),
      ctx,
    );
    expect(outputs).toEqual([]);
  });

  test('PostCompact emits the single compaction event', async () => {
    const outputs = await adapter.onHook(
      envelope('PostCompact', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'PostCompact',
        trigger: 'auto',
      }),
      ctx,
    );
    expect(outputs).toHaveLength(1);
    if (outputs[0]?.kind !== 'events') throw new Error('unreachable');
    expect(outputs[0].events[0]?.kind).toBe('compaction');
  });
});

describe('CodexAdapter.onHook — Stop', () => {
  test('emits an agent_turn but never a session_end (Codex Stop fires every turn)', async () => {
    const outputs = await adapter.onHook(
      envelope('Stop', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'Stop',
        last_assistant_message: 'done',
      }),
      ctx,
    );
    expect(outputs).toHaveLength(1);
    if (outputs[0]?.kind !== 'events') throw new Error('unreachable');
    expect(outputs[0].events[0]?.kind).toBe('agent_turn');
    expect(outputs.some((o) => o.kind === 'session_end')).toBe(false);
  });

  test('emits nothing for an empty last_assistant_message', async () => {
    const outputs = await adapter.onHook(
      envelope('Stop', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'Stop',
        last_assistant_message: '   ',
      }),
      ctx,
    );
    expect(outputs).toEqual([]);
  });
});

describe('CodexAdapter.onHook — SessionEnd', () => {
  test('emits session_end with the given reason', async () => {
    const outputs = await adapter.onHook(
      envelope('SessionEnd', {
        session_id: 'codex-sess-1',
        cwd: '/repo',
        hook_event_name: 'SessionEnd',
        reason: 'exit',
      }),
      ctx,
    );
    expect(outputs).toHaveLength(1);
    if (outputs[0]?.kind !== 'session_end') throw new Error('unreachable');
    expect(outputs[0].reason).toBe('exit');
  });
});

describe('CodexAdapter.onHook — unrecognized event', () => {
  test('returns an empty array rather than throwing', async () => {
    const outputs = await adapter.onHook(envelope('SubagentStart', {}), ctx);
    expect(outputs).toEqual([]);
  });
});
