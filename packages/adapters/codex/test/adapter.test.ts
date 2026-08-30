import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { AdapterOutput, RepoRef } from '@driftlock/core';
import { CodexAdapter } from '../src/adapter.ts';

async function collect(fixture: string): Promise<AdapterOutput[]> {
  const adapter = new CodexAdapter();
  const repo: RepoRef = { root: '/repo', repoId: 'repo-1' };
  const path = join(import.meta.dir, '..', '..', '..', '..', 'fixtures', 'codex', fixture);
  const outputs: AdapterOutput[] = [];
  for await (const output of adapter.parseTranscript({ path, repoRoot: '/repo' }, { repo })) {
    outputs.push(output);
  }
  return outputs;
}

describe('CodexAdapter — session-1 (straightforward task)', () => {
  test('emits session_start with the task text', async () => {
    const outputs = await collect('session-1.jsonl');
    const start = outputs.find((o) => o.kind === 'session_start');
    expect(start).toBeDefined();
    if (start?.kind !== 'session_start') throw new Error('unreachable');
    expect(start.session.taskText).toBe('Add rate limiting to the login endpoint');
    expect(start.session.agent).toBe('codex');
  });

  test('reconstructs a file_edit from the apply_patch call', async () => {
    const outputs = await collect('session-1.jsonl');
    const events = outputs.find((o) => o.kind === 'events');
    if (events?.kind !== 'events') throw new Error('unreachable');
    const edit = events.events.find((e) => e.kind === 'file_edit');
    expect(edit).toBeDefined();
    if (edit?.kind !== 'file_edit') throw new Error('unreachable');
    expect(edit.payload.path).toBe('src/api/login.ts');
    expect(edit.payload.hunks.length).toBeGreaterThan(0);
  });

  test('detects the test_run and records a passing exit code', async () => {
    const outputs = await collect('session-1.jsonl');
    const events = outputs.find((o) => o.kind === 'events');
    if (events?.kind !== 'events') throw new Error('unreachable');
    const testRun = events.events.find((e) => e.kind === 'test_run');
    expect(testRun).toBeDefined();
    if (testRun?.kind !== 'test_run') throw new Error('unreachable');
    expect(testRun.payload.exitCode).toBe(0);
    expect(testRun.payload.command).toContain('test');
  });

  test('ends the session with reason stop', async () => {
    const outputs = await collect('session-1.jsonl');
    const end = outputs.find((o) => o.kind === 'session_end');
    expect(end).toBeDefined();
    if (end?.kind !== 'session_end') throw new Error('unreachable');
    expect(end.reason).toBe('stop');
  });
});

describe('CodexAdapter — session-2 (edit/test loop)', () => {
  test('detects four test_run events, with the last one passing', async () => {
    const outputs = await collect('session-2.jsonl');
    const events = outputs.find((o) => o.kind === 'events');
    if (events?.kind !== 'events') throw new Error('unreachable');
    const testRuns = events.events.filter((e) => e.kind === 'test_run');
    expect(testRuns).toHaveLength(4);
    expect(testRuns[0]?.kind === 'test_run' && testRuns[0].payload.exitCode).toBe(1);
    expect(testRuns[1]?.kind === 'test_run' && testRuns[1].payload.exitCode).toBe(1);
    expect(testRuns[2]?.kind === 'test_run' && testRuns[2].payload.exitCode).toBe(1);
    expect(testRuns[3]?.kind === 'test_run' && testRuns[3].payload.exitCode).toBe(0);
  });

  test('reconstructs four file_edit events on the same path', async () => {
    const outputs = await collect('session-2.jsonl');
    const events = outputs.find((o) => o.kind === 'events');
    if (events?.kind !== 'events') throw new Error('unreachable');
    const edits = events.events.filter((e) => e.kind === 'file_edit');
    expect(edits).toHaveLength(4);
    for (const edit of edits) {
      if (edit.kind !== 'file_edit') throw new Error('unreachable');
      expect(edit.payload.path).toBe('src/billing/invoice.ts');
    }
  });

  test('events are all present in file order (seq assigned later by the store)', async () => {
    const outputs = await collect('session-2.jsonl');
    const events = outputs.find((o) => o.kind === 'events');
    if (events?.kind !== 'events') throw new Error('unreachable');
    const kinds = events.events.map((e) => e.kind);
    expect(kinds[0]).toBe('user_turn');
    expect(kinds.at(-1)).toBe('agent_turn');
  });
});
