import { describe, expect, test } from 'bun:test';
import { rereadAnalyzer } from '../src/reread.ts';
import { fakeEvents, fakeSession } from './helpers.ts';

describe('rereadAnalyzer', () => {
  test('returns nothing when every file is read once', async () => {
    const events = fakeEvents([
      { kind: 'file_read', payload: { path: 'a.ts' } },
      { kind: 'file_read', payload: { path: 'b.ts' } },
    ]);
    const findings = await rereadAnalyzer.run({
      session: fakeSession(),
      events,
      previousFindings: [],
    });
    expect(findings).toHaveLength(0);
  });

  test('flags a re-read after compaction as warn', async () => {
    const events = fakeEvents([
      { kind: 'file_read', payload: { path: 'a.ts' } },
      { kind: 'compaction', payload: {} },
      { kind: 'file_read', payload: { path: 'a.ts' } },
    ]);
    const findings = await rereadAnalyzer.run({
      session: fakeSession(),
      events,
      previousFindings: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warn');
    expect(findings[0]?.data).toMatchObject({ rereads: 1, rereadsAfterCompaction: 1 });
  });

  test('flags a high re-read ratio without compaction as warn', async () => {
    const events = fakeEvents([
      { kind: 'file_read', payload: { path: 'a.ts' } },
      { kind: 'file_read', payload: { path: 'a.ts' } },
      { kind: 'file_read', payload: { path: 'a.ts' } },
    ]);
    const findings = await rereadAnalyzer.run({
      session: fakeSession(),
      events,
      previousFindings: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warn');
  });
});
