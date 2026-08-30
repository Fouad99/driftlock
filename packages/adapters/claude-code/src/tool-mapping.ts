import type { Hunk, NewEvent } from '@driftlock/core';
import { parseEventPayload } from '@driftlock/core';
import { isTestCommand } from './test-detect.ts';

// Architecture doc §4.3, per-agent table: "PostToolUse (Edit/Write/MultiEdit
// → file_edit; Bash → tool_call, plus test_run if command matches test
// patterns)". `tool_input`/`tool_output` shapes are the *documented* field
// names (verified), but their *contents* per tool aren't documented — every
// extraction below is defensive with a raw fallback, so a wrong guess loses
// structure, never data (architecture doc §5.2's `raw` rule, applied at the
// field level here rather than the whole-event level).

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function extractOutputText(toolOutput: unknown): string {
  if (typeof toolOutput === 'string') return toolOutput;
  const o = record(toolOutput);
  for (const key of ['stdout', 'output', 'text', 'content', 'result']) {
    const v = str(o[key]);
    if (v !== undefined) return v;
  }
  return JSON.stringify(toolOutput ?? null);
}

function extractOk(toolOutput: unknown): boolean {
  const o = record(toolOutput);
  if (typeof o.is_error === 'boolean') return !o.is_error;
  if (typeof o.exit_code === 'number') return o.exit_code === 0;
  if (typeof o.exitCode === 'number') return o.exitCode === 0;
  if (typeof o.error === 'string' && o.error.length > 0) return false;
  return true;
}

function extractExitCode(toolOutput: unknown): number {
  const o = record(toolOutput);
  if (typeof o.exit_code === 'number') return o.exit_code;
  if (typeof o.exitCode === 'number') return o.exitCode;
  return extractOk(toolOutput) ? 0 : 1;
}

function hunkFromReplace(oldString: string, newString: string): Hunk {
  return {
    oldStart: 0,
    oldLines: oldString.length > 0 ? oldString.split('\n').length : 0,
    newStart: 0,
    newLines: newString.length > 0 ? newString.split('\n').length : 0,
    text: [
      ...oldString.split('\n').map((l) => `-${l}`),
      ...newString.split('\n').map((l) => `+${l}`),
    ].join('\n'),
  };
}

function mapEdit(
  toolInput: unknown,
  callId: string | undefined,
  ts: number,
  sessionId: string,
): NewEvent[] {
  const input = record(toolInput);
  const path = str(input.file_path) ?? '(unknown path)';
  const hunk = hunkFromReplace(str(input.old_string) ?? '', str(input.new_string) ?? '');
  const parsed = parseEventPayload('file_edit', { path, hunks: [hunk], callId });
  return [{ sessionId, ts, ...parsed } as NewEvent];
}

function mapMultiEdit(
  toolInput: unknown,
  callId: string | undefined,
  ts: number,
  sessionId: string,
): NewEvent[] {
  const input = record(toolInput);
  const path = str(input.file_path) ?? '(unknown path)';
  const edits = Array.isArray(input.edits) ? (input.edits as unknown[]) : [];
  const hunks = edits.map((e) => {
    const edit = record(e);
    return hunkFromReplace(str(edit.old_string) ?? '', str(edit.new_string) ?? '');
  });
  const parsed = parseEventPayload('file_edit', { path, hunks, callId });
  return [{ sessionId, ts, ...parsed } as NewEvent];
}

function mapWrite(
  toolInput: unknown,
  callId: string | undefined,
  ts: number,
  sessionId: string,
): NewEvent[] {
  const input = record(toolInput);
  const path = str(input.file_path) ?? '(unknown path)';
  const content = str(input.content) ?? '';
  const hunk: Hunk = {
    oldStart: 0,
    oldLines: 0, // prior content unknown — Write is whole-file, not a diff
    newStart: 0,
    newLines: content.length > 0 ? content.split('\n').length : 0,
    text: content
      .split('\n')
      .map((l) => `+${l}`)
      .join('\n'),
  };
  const parsed = parseEventPayload('file_edit', { path, hunks: [hunk], callId });
  return [{ sessionId, ts, ...parsed } as NewEvent];
}

function mapBash(
  toolInput: unknown,
  toolOutput: unknown,
  callId: string | undefined,
  ts: number,
  sessionId: string,
): NewEvent[] {
  const input = record(toolInput);
  const command = str(input.command) ?? '';

  if (isTestCommand(command)) {
    const parsed = parseEventPayload('test_run', {
      command,
      exitCode: extractExitCode(toolOutput),
      summary: extractOutputText(toolOutput),
      callId,
    });
    return [{ sessionId, ts, ...parsed } as NewEvent];
  }

  const call = parseEventPayload('tool_call', {
    callId: callId ?? '',
    name: 'Bash',
    args: { command },
  });
  const result = parseEventPayload('tool_result', {
    callId: callId ?? '',
    ok: extractOk(toolOutput),
    output: extractOutputText(toolOutput),
  });
  return [{ sessionId, ts, ...call } as NewEvent, { sessionId, ts, ...result } as NewEvent];
}

function mapRead(toolInput: unknown, ts: number, sessionId: string): NewEvent[] {
  const input = record(toolInput);
  const path = str(input.file_path) ?? '(unknown path)';
  const parsed = parseEventPayload('file_read', { path });
  return [{ sessionId, ts, ...parsed } as NewEvent];
}

/**
 * Maps `TodoWrite`'s `{ todos: [{content, status, activeForm?}] }` input to
 * one `plan_item` per todo. Claude Code's todos have no stable id of their
 * own — `TodoWrite` sends its *whole* current list on every call, so the
 * item's position is the closest thing to a stable identity across calls
 * (unlike a reordered list, a growing/shrinking one still keeps each
 * existing item's index). `content`/`status` are read defensively; an item
 * missing either is skipped rather than guessed at.
 */
function mapTodoWrite(toolInput: unknown, ts: number, sessionId: string): NewEvent[] {
  const todos = record(toolInput).todos;
  if (!Array.isArray(todos)) return [];
  const events: NewEvent[] = [];
  todos.forEach((t, i) => {
    const todo = record(t);
    const text = str(todo.content);
    const status = str(todo.status);
    if (text === undefined || status === undefined) return;
    const parsed = parseEventPayload('plan_item', { id: `todo-${i}`, text, status });
    events.push({ sessionId, ts, ...parsed } as NewEvent);
  });
  return events;
}

function mapGeneric(
  toolName: string,
  toolInput: unknown,
  toolOutput: unknown,
  callId: string | undefined,
  ts: number,
  sessionId: string,
): NewEvent[] {
  const call = parseEventPayload('tool_call', {
    callId: callId ?? '',
    name: toolName,
    args: toolInput,
  });
  const result = parseEventPayload('tool_result', {
    callId: callId ?? '',
    ok: extractOk(toolOutput),
    output: extractOutputText(toolOutput),
  });
  return [{ sessionId, ts, ...call } as NewEvent, { sessionId, ts, ...result } as NewEvent];
}

/** Maps one PostToolUse hook payload to the events it represents. */
export function mapPostToolUse(
  toolName: string,
  toolInput: unknown,
  toolOutput: unknown,
  callId: string | undefined,
  ts: number,
  sessionId: string,
): NewEvent[] {
  switch (toolName) {
    case 'Edit':
      return mapEdit(toolInput, callId, ts, sessionId);
    case 'MultiEdit':
      return mapMultiEdit(toolInput, callId, ts, sessionId);
    case 'Write':
      return mapWrite(toolInput, callId, ts, sessionId);
    case 'Bash':
      return mapBash(toolInput, toolOutput, callId, ts, sessionId);
    case 'Read':
      return mapRead(toolInput, ts, sessionId);
    case 'TodoWrite':
      return mapTodoWrite(toolInput, ts, sessionId);
    default:
      return mapGeneric(toolName, toolInput, toolOutput, callId, ts, sessionId);
  }
}
