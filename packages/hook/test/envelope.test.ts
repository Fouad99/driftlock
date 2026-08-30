import { describe, expect, test } from 'bun:test';
import { buildEnvelope } from '../src/envelope.ts';

describe('buildEnvelope', () => {
  test('parses valid JSON stdin as the payload', () => {
    const env = buildEnvelope('claude-code', 'SessionStart', '/repo', '{"a":1}');
    expect(env.payload).toEqual({ a: 1 });
    expect(env.agent).toBe('claude-code');
    expect(env.event).toBe('SessionStart');
    expect(env.cwd).toBe('/repo');
  });

  test('falls back to {raw} when stdin is not valid JSON', () => {
    const env = buildEnvelope('codex', 'notify', '/repo', 'not json at all');
    expect(env.payload).toEqual({ raw: 'not json at all' });
  });

  test('defaults to an empty object payload for empty stdin', () => {
    const env = buildEnvelope('codex', 'notify', '/repo', '   ');
    expect(env.payload).toEqual({});
  });

  test('sets receivedAt to roughly now', () => {
    const before = Date.now();
    const env = buildEnvelope('codex', 'notify', '/repo', '{}');
    expect(env.receivedAt).toBeGreaterThanOrEqual(before);
    expect(env.receivedAt).toBeLessThanOrEqual(Date.now());
  });
});
