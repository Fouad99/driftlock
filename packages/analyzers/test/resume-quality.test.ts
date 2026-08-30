import { describe, expect, test } from 'bun:test';
import { resumeQualityAnalyzer } from '../src/resume-quality.ts';
import { fakeEvents, fakeSession } from './helpers.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('resumeQualityAnalyzer', () => {
  test('returns nothing when there is no previous session', async () => {
    const findings = await resumeQualityAnalyzer.run({
      session: fakeSession({ startedAt: 100 * DAY_MS }),
      events: fakeEvents([{ kind: 'user_turn', payload: { text: 'hi' } }]),
      previousFindings: [],
      previousSessionEndedAt: null,
    });
    expect(findings).toEqual([]);
  });

  test('returns nothing when the previous session data is unavailable (undefined)', async () => {
    const findings = await resumeQualityAnalyzer.run({
      session: fakeSession({ startedAt: 100 * DAY_MS }),
      events: fakeEvents([{ kind: 'user_turn', payload: { text: 'hi' } }]),
      previousFindings: [],
    });
    expect(findings).toEqual([]);
  });

  test('returns nothing when the gap is at or under the 3-day threshold', async () => {
    const findings = await resumeQualityAnalyzer.run({
      session: fakeSession({ startedAt: 10 * DAY_MS }),
      events: fakeEvents([{ kind: 'user_turn', payload: { text: 'hi' } }]),
      previousFindings: [],
      previousSessionEndedAt: 10 * DAY_MS - 2 * DAY_MS,
    });
    expect(findings).toEqual([]);
  });

  test('returns nothing for an empty session even after a long gap', async () => {
    const findings = await resumeQualityAnalyzer.run({
      session: fakeSession({ startedAt: 10 * DAY_MS }),
      events: [],
      previousFindings: [],
      previousSessionEndedAt: 0,
    });
    expect(findings).toEqual([]);
  });

  test('flags a resume after a long gap, counting turns and clarifying questions before the first edit', async () => {
    const events = fakeEvents([
      { kind: 'user_turn', payload: { text: 'pick up where we left off' } },
      { kind: 'agent_turn', payload: { text: 'which file were we editing?' } },
      { kind: 'agent_turn', payload: { text: 'and which branch?' } },
      { kind: 'agent_turn', payload: { text: 'got it, starting now' } },
      { kind: 'file_edit', payload: { path: 'src/a.ts', hunks: [] } },
      { kind: 'agent_turn', payload: { text: 'done' } },
    ]);
    const findings = await resumeQualityAnalyzer.run({
      session: fakeSession({ startedAt: 10 * DAY_MS }),
      events,
      previousFindings: [],
      previousSessionEndedAt: 10 * DAY_MS - 5 * DAY_MS,
    });

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.severity).toBe('info');
    expect(finding?.data).toEqual({ gapDays: 5, turnsBeforeFirstEdit: 4, clarifyingTurns: 2 });
    expect(finding?.fromSeq).toBe(0);
    expect(finding?.toSeq).toBe(4); // the file_edit's own seq
  });

  test('when there is no file_edit at all, counts turns across the whole session', async () => {
    const events = fakeEvents([
      { kind: 'user_turn', payload: { text: 'status?' } },
      { kind: 'agent_turn', payload: { text: 'still thinking about it' } },
    ]);
    const findings = await resumeQualityAnalyzer.run({
      session: fakeSession({ startedAt: 10 * DAY_MS }),
      events,
      previousFindings: [],
      previousSessionEndedAt: 10 * DAY_MS - 5 * DAY_MS,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toEqual({ gapDays: 5, turnsBeforeFirstEdit: 2, clarifyingTurns: 0 });
    expect(findings[0]?.toSeq).toBe(1); // last event's seq, since there's no file_edit
  });
});
