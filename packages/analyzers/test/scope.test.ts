import { describe, expect, test } from 'bun:test';
import { scopeAnalyzer } from '../src/scope.ts';
import { fakeEvents, fakeSession } from './helpers.ts';

describe('scopeAnalyzer', () => {
  test('returns nothing when the task text has no path-like tokens', async () => {
    const events = fakeEvents([
      { kind: 'file_edit', payload: { path: 'src/billing/plan.ts', hunks: [] } },
    ]);
    const findings = await scopeAnalyzer.run({
      session: fakeSession(),
      events,
      task: { text: 'fix the login bug', source: 'transcript' },
      previousFindings: [],
    });
    expect(findings).toHaveLength(0);
  });

  test('flags an edit outside the task-mentioned path', async () => {
    const events = fakeEvents([
      {
        kind: 'file_edit',
        payload: {
          path: 'src/auth/session.ts',
          hunks: [{ oldStart: 0, oldLines: 1, newStart: 0, newLines: 1, text: '-a\n+b' }],
        },
      },
      {
        kind: 'file_edit',
        payload: {
          path: 'src/billing/plan.ts',
          hunks: [{ oldStart: 0, oldLines: 5, newStart: 0, newLines: 5, text: '-a\n+b' }],
        },
      },
    ]);
    const findings = await scopeAnalyzer.run({
      session: fakeSession(),
      events,
      task: { text: 'fix src/auth/session.ts', source: 'transcript' },
      previousFindings: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toMatchObject({ files: [{ path: 'src/billing/plan.ts', size: 10 }] });
  });
});
