import { describe, expect, test } from 'bun:test';
import { testBeforeClaimAnalyzer } from '../src/test-before-claim.ts';
import { fakeEvents, fakeSession } from './helpers.ts';

describe('testBeforeClaimAnalyzer', () => {
  test('warns when "done" is claimed with no test after the last edit', async () => {
    const events = fakeEvents([
      { kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
      { kind: 'agent_turn', payload: { text: 'Done, that should work now.' } },
    ]);
    const findings = await testBeforeClaimAnalyzer.run({
      session: fakeSession(),
      events,
      previousFindings: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warn');
  });

  test('does not warn when a test ran after the last edit', async () => {
    const events = fakeEvents([
      { kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
      { kind: 'test_run', payload: { command: 'npm test', exitCode: 0 } },
      { kind: 'agent_turn', payload: { text: 'Done, tests pass.' } },
    ]);
    const findings = await testBeforeClaimAnalyzer.run({
      session: fakeSession(),
      events,
      previousFindings: [],
    });
    expect(findings).toHaveLength(0);
  });

  test('does not warn when there is no completion language', async () => {
    const events = fakeEvents([
      { kind: 'file_edit', payload: { path: 'a.ts', hunks: [] } },
      { kind: 'agent_turn', payload: { text: 'Still investigating.' } },
    ]);
    const findings = await testBeforeClaimAnalyzer.run({
      session: fakeSession(),
      events,
      previousFindings: [],
    });
    expect(findings).toHaveLength(0);
  });
});
