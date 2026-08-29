import { describe, expect, test } from 'bun:test';
import { loopAnalyzer } from '../src/loop.ts';
import { fakeEvents, fakeSession } from './helpers.ts';

describe('loopAnalyzer', () => {
  test('flags 3+ edit/test cycles on the same path', async () => {
    const events = fakeEvents([
      { kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
      { kind: 'test_run', payload: { command: 'npm test', exitCode: 1 } },
      { kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
      { kind: 'test_run', payload: { command: 'npm test', exitCode: 1 } },
      { kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
      { kind: 'test_run', payload: { command: 'npm test', exitCode: 1 } },
      { kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
    ]);
    const findings = await loopAnalyzer.run({
      session: fakeSession(),
      events,
      previousFindings: [],
    });
    const loopFinding = findings.find((f) => f.title.includes('edit/test cycles'));
    expect(loopFinding).toBeDefined();
    expect(loopFinding?.data).toMatchObject({ path: 'a.ts', cycles: 3 });
  });

  test('does not flag fewer than 3 cycles', async () => {
    const events = fakeEvents([
      { kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
      { kind: 'test_run', payload: { command: 'npm test', exitCode: 1 } },
      { kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
    ]);
    const findings = await loopAnalyzer.run({
      session: fakeSession(),
      events,
      previousFindings: [],
    });
    expect(findings.filter((f) => f.title.includes('edit/test cycles'))).toHaveLength(0);
  });

  test('flags 3+ identical tool calls', async () => {
    const events = fakeEvents([
      { kind: 'tool_call', payload: { callId: '1', name: 'Bash', args: { command: 'ls' } } },
      { kind: 'tool_call', payload: { callId: '2', name: 'Bash', args: { command: 'ls' } } },
      { kind: 'tool_call', payload: { callId: '3', name: 'Bash', args: { command: 'ls' } } },
    ]);
    const findings = await loopAnalyzer.run({
      session: fakeSession(),
      events,
      previousFindings: [],
    });
    const dupFinding = findings.find((f) => f.title.includes('identical tool calls'));
    expect(dupFinding).toBeDefined();
    expect(dupFinding?.data).toMatchObject({ count: 3 });
  });
});
