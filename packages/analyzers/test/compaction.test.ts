import { describe, expect, test } from 'bun:test';
import { compactionAnalyzer } from '../src/compaction.ts';
import { fakeEvents, fakeSession } from './helpers.ts';

describe('compactionAnalyzer', () => {
  test('returns nothing when there is no compaction', async () => {
    const events = fakeEvents([{ kind: 'user_turn', payload: { text: 'hi' } }]);
    const findings = await compactionAnalyzer.run({
      session: fakeSession(),
      events,
      previousFindings: [],
    });
    expect(findings).toHaveLength(0);
  });

  test('warns when a user turn precedes an early compaction', async () => {
    const events = fakeEvents([
      { kind: 'user_turn', payload: { text: 'do the thing' } },
      { kind: 'compaction', payload: { tokensBefore: 100000, tokensAfter: 10000 } },
      { kind: 'agent_turn', payload: { text: 'ok' } },
      { kind: 'agent_turn', payload: { text: 'ok' } },
      { kind: 'agent_turn', payload: { text: 'ok' } },
    ]);
    const findings = await compactionAnalyzer.run({
      session: fakeSession(),
      events,
      previousFindings: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warn');
    expect(findings[0]?.data).toMatchObject({ count: 1, userTurnsBefore: 1 });
  });

  test('reports info when compaction happens late with no preceding instructions lost', async () => {
    const events = fakeEvents([
      { kind: 'agent_turn', payload: { text: 'a' } },
      { kind: 'agent_turn', payload: { text: 'b' } },
      { kind: 'agent_turn', payload: { text: 'c' } },
      { kind: 'agent_turn', payload: { text: 'd' } },
      { kind: 'compaction', payload: { tokensBefore: 100000, tokensAfter: 10000 } },
    ]);
    const findings = await compactionAnalyzer.run({
      session: fakeSession(),
      events,
      previousFindings: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('info');
  });
});
