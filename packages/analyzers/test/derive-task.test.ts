import { describe, expect, test } from 'bun:test';
import { deriveTask } from '../src/derive-task.ts';
import { fakeEvents, fakeSession } from './helpers.ts';

describe('deriveTask', () => {
  test('prefers session.taskText over everything else', () => {
    const session = fakeSession({ taskText: 'from the adapter' });
    const events = fakeEvents([{ kind: 'user_turn', payload: { text: 'from the prompt' } }]);
    expect(deriveTask(session, events)).toEqual({ text: 'from the adapter', source: 'transcript' });
  });

  test('falls back to the first user prompt when taskText is null', () => {
    const session = fakeSession({ taskText: null });
    const events = fakeEvents([
      { kind: 'user_turn', payload: { text: 'first ask' } },
      { kind: 'user_turn', payload: { text: 'second ask' } },
    ]);
    expect(deriveTask(session, events)).toEqual({ text: 'first ask', source: 'transcript' });
  });

  test('falls back to the most recent open plan_item when there is no user_turn', () => {
    const session = fakeSession({ taskText: null });
    const events = fakeEvents([
      { kind: 'plan_item', payload: { id: '1', text: 'step one', status: 'completed' } },
      { kind: 'plan_item', payload: { id: '2', text: 'step two', status: 'in_progress' } },
    ]);
    expect(deriveTask(session, events)).toEqual({ text: 'step two', source: 'transcript' });
  });

  test('skips closed plan_items (completed/done/cancelled) regardless of case', () => {
    const session = fakeSession({ taskText: null });
    const events = fakeEvents([
      { kind: 'plan_item', payload: { id: '1', text: 'still open', status: 'pending' } },
      { kind: 'plan_item', payload: { id: '2', text: 'finished', status: 'Done' } },
    ]);
    expect(deriveTask(session, events)).toEqual({ text: 'still open', source: 'transcript' });
  });

  test('returns undefined when there is nothing to derive from', () => {
    const session = fakeSession({ taskText: null });
    const events = fakeEvents([
      { kind: 'tool_call', payload: { callId: '1', name: 'x', args: {} } },
    ]);
    expect(deriveTask(session, events)).toBeUndefined();
  });
});
