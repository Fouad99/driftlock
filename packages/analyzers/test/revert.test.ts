import { describe, expect, test } from 'bun:test';
import { revertAnalyzer } from '../src/revert.ts';
import { fakeEvents, fakeSession } from './helpers.ts';

describe('revertAnalyzer', () => {
  test('returns nothing when no hunk cancels an earlier one', async () => {
    const events = fakeEvents([
      {
        kind: 'file_edit',
        payload: {
          path: 'a.ts',
          hunks: [{ oldStart: 0, oldLines: 1, newStart: 0, newLines: 1, text: '-foo\n+bar' }],
        },
      },
    ]);
    const findings = await revertAnalyzer.run({
      session: fakeSession(),
      events,
      previousFindings: [],
    });
    expect(findings).toHaveLength(0);
  });

  test('flags a later edit that re-adds lines an earlier edit removed', async () => {
    const events = fakeEvents([
      {
        kind: 'file_edit',
        payload: {
          path: 'a.ts',
          hunks: [{ oldStart: 0, oldLines: 1, newStart: 0, newLines: 1, text: '-foo\n+bar' }],
        },
      },
      {
        kind: 'file_edit',
        payload: {
          path: 'a.ts',
          hunks: [{ oldStart: 0, oldLines: 1, newStart: 0, newLines: 1, text: '-bar\n+foo' }],
        },
      },
    ]);
    const findings = await revertAnalyzer.run({
      session: fakeSession(),
      events,
      previousFindings: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toMatchObject({ revertedHunks: 1, totalHunks: 2 });
  });
});
