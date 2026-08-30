import { describe, expect, test } from 'bun:test';
import { mapPostToolUse } from '../src/tool-mapping.ts';

describe('mapPostToolUse — Edit', () => {
  test('produces one file_edit event with a single hunk', () => {
    const events = mapPostToolUse(
      'Edit',
      { file_path: 'src/a.ts', old_string: 'foo', new_string: 'bar' },
      { ok: true },
      'call-1',
      1000,
      'sess-1',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('file_edit');
    if (events[0]?.kind !== 'file_edit') throw new Error('unreachable');
    expect(events[0].payload.path).toBe('src/a.ts');
    expect(events[0].payload.hunks).toHaveLength(1);
  });
});

describe('mapPostToolUse — MultiEdit', () => {
  test('produces one file_edit event with a hunk per edit', () => {
    const events = mapPostToolUse(
      'MultiEdit',
      {
        file_path: 'src/a.ts',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      },
      { ok: true },
      'call-1',
      1000,
      'sess-1',
    );
    expect(events).toHaveLength(1);
    if (events[0]?.kind !== 'file_edit') throw new Error('unreachable');
    expect(events[0].payload.hunks).toHaveLength(2);
  });
});

describe('mapPostToolUse — Write', () => {
  test('produces one file_edit event covering the whole new content', () => {
    const events = mapPostToolUse(
      'Write',
      { file_path: 'src/new.ts', content: 'line1\nline2\nline3' },
      { ok: true },
      'call-1',
      1000,
      'sess-1',
    );
    expect(events).toHaveLength(1);
    if (events[0]?.kind !== 'file_edit') throw new Error('unreachable');
    expect(events[0].payload.path).toBe('src/new.ts');
    expect(events[0].payload.hunks[0]?.newLines).toBe(3);
    expect(events[0].payload.hunks[0]?.oldLines).toBe(0);
  });
});

describe('mapPostToolUse — Bash', () => {
  test('a test command produces a test_run event with the inferred exit code', () => {
    const events = mapPostToolUse(
      'Bash',
      { command: 'npm test' },
      { exit_code: 1, stdout: '1 failing' },
      'call-1',
      1000,
      'sess-1',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('test_run');
    if (events[0]?.kind !== 'test_run') throw new Error('unreachable');
    expect(events[0].payload.exitCode).toBe(1);
    expect(events[0].payload.command).toBe('npm test');
  });

  test('a non-test command produces a paired tool_call and tool_result', () => {
    const events = mapPostToolUse(
      'Bash',
      { command: 'ls -la' },
      { stdout: 'file.txt' },
      'call-1',
      1000,
      'sess-1',
    );
    expect(events.map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
    if (events[1]?.kind !== 'tool_result') throw new Error('unreachable');
    expect(events[1].payload.ok).toBe(true);
    expect(events[1].payload.output).toBe('file.txt');
  });
});

describe('mapPostToolUse — Read', () => {
  test('produces a file_read event', () => {
    const events = mapPostToolUse(
      'Read',
      { file_path: 'src/a.ts' },
      'contents',
      'call-1',
      1000,
      'sess-1',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('file_read');
    if (events[0]?.kind !== 'file_read') throw new Error('unreachable');
    expect(events[0].payload.path).toBe('src/a.ts');
  });
});

describe('mapPostToolUse — generic tool', () => {
  test('falls back to a paired tool_call/tool_result for unrecognized tools', () => {
    const events = mapPostToolUse(
      'Grep',
      { pattern: 'foo' },
      { matches: 3 },
      'call-1',
      1000,
      'sess-1',
    );
    expect(events.map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
    if (events[0]?.kind !== 'tool_call') throw new Error('unreachable');
    expect(events[0].payload.name).toBe('Grep');
  });

  test('never throws on malformed tool_input/tool_output', () => {
    expect(() =>
      mapPostToolUse('SomeTool', null, undefined, undefined, 1000, 'sess-1'),
    ).not.toThrow();
    expect(() =>
      mapPostToolUse('Edit', 'not an object', 'also not an object', undefined, 1000, 'sess-1'),
    ).not.toThrow();
  });
});

describe('mapPostToolUse — TodoWrite', () => {
  test('produces one plan_item per todo, keyed by list position', () => {
    const events = mapPostToolUse(
      'TodoWrite',
      {
        todos: [
          {
            content: 'write the limiter',
            status: 'in_progress',
            activeForm: 'Writing the limiter',
          },
          { content: 'add tests', status: 'pending', activeForm: 'Adding tests' },
        ],
      },
      undefined,
      undefined,
      1000,
      'sess-1',
    );
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('plan_item');
    if (events[0]?.kind !== 'plan_item' || events[1]?.kind !== 'plan_item') {
      throw new Error('unreachable');
    }
    expect(events[0].payload).toEqual({
      id: 'todo-0',
      text: 'write the limiter',
      status: 'in_progress',
    });
    expect(events[1].payload).toEqual({ id: 'todo-1', text: 'add tests', status: 'pending' });
  });

  test('skips todos missing content or status rather than guessing', () => {
    const events = mapPostToolUse(
      'TodoWrite',
      {
        todos: [
          { content: 'ok', status: 'pending' },
          { status: 'pending' },
          { content: 'no status' },
        ],
      },
      undefined,
      undefined,
      1000,
      'sess-1',
    );
    expect(events).toHaveLength(1);
    if (events[0]?.kind !== 'plan_item') throw new Error('unreachable');
    expect(events[0].payload.text).toBe('ok');
  });

  test('never throws when todos is missing or malformed', () => {
    expect(() =>
      mapPostToolUse('TodoWrite', {}, undefined, undefined, 1000, 'sess-1'),
    ).not.toThrow();
    expect(
      mapPostToolUse('TodoWrite', { todos: 'not an array' }, undefined, undefined, 1000, 'sess-1'),
    ).toEqual([]);
  });
});
