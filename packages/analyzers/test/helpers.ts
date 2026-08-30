import type { Event, EventKind, NewEvent, Session } from '@driftlock/core';
import { EventPayloadByKind } from '@driftlock/core';

export function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    agent: 'claude-code',
    agentSession: null,
    repoRoot: '/repo',
    branch: null,
    headBefore: null,
    headAfter: null,
    startedAt: 1000,
    endedAt: 2000,
    endReason: 'stop',
    taskText: null,
    tokenIn: null,
    tokenOut: null,
    costUsd: null,
    source: 'hooks',
    ...overrides,
  };
}

/** Builds Events with sequential seqs, validating each payload against its kind's schema. */
export function fakeEvents(
  specs: { kind: EventKind; payload: unknown; ts?: number }[],
  sessionId = 'session-1',
): Event[] {
  return specs.map((spec, i) => {
    const schema = EventPayloadByKind[spec.kind];
    const payload = schema.parse(spec.payload);
    return {
      sessionId,
      seq: i,
      ts: spec.ts ?? 1000 + i,
      kind: spec.kind,
      payload,
    } as Event;
  });
}

export type EventSpec = { kind: EventKind; payload: unknown; ts?: number };
export type { NewEvent };
