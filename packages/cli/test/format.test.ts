import { describe, expect, test } from 'bun:test';
import type { Finding, Session } from '@driftlock/core';
import { formatExplain, formatReport } from '../src/format.ts';

const session: Session = {
  id: 'sess-1',
  agent: 'codex',
  agentSession: 'agent-sess-1',
  repoRoot: '/repo',
  branch: 'main',
  headBefore: null,
  headAfter: null,
  startedAt: 0,
  endedAt: 42 * 60_000,
  endReason: 'stop',
  taskText: 'fix the bug',
  tokenIn: null,
  tokenOut: null,
  costUsd: null,
  source: 'transcript',
};

describe('formatReport', () => {
  test('renders the header and a no-findings line when there are none', () => {
    const out = formatReport(session, []);
    expect(out).toContain('sess-1');
    expect(out).toContain('codex');
    expect(out).toContain('42 min');
    expect(out).toContain('no findings');
  });

  test('renders each finding with severity, analyzer, title, and seq range', () => {
    const findings: Finding[] = [
      {
        id: 'f1',
        sessionId: 'sess-1',
        analyzer: 'loop',
        severity: 'warn',
        title: '3 edit/test cycles on a.ts',
        explanation: '...',
        fromSeq: 1,
        toSeq: 9,
        data: null,
        createdAt: 0,
        resolvedAt: null,
      },
    ];
    const out = formatReport(session, findings);
    expect(out).toContain('warn');
    expect(out).toContain('loop');
    expect(out).toContain('3 edit/test cycles on a.ts');
    expect(out).toContain('(seq 1–9)');
  });
});

describe('formatExplain', () => {
  test("lists the events within a finding's evidence range", () => {
    const findings: Finding[] = [
      {
        id: 'f1',
        sessionId: 'sess-1',
        analyzer: 'loop',
        severity: 'warn',
        title: 'loop',
        explanation: 'explanation text',
        fromSeq: 0,
        toSeq: 1,
        data: null,
        createdAt: 0,
        resolvedAt: null,
      },
    ];
    const events = [
      { sessionId: 'sess-1', seq: 0, ts: 0, kind: 'user_turn' as const, payload: { text: 'hi' } },
      {
        sessionId: 'sess-1',
        seq: 1,
        ts: 1,
        kind: 'user_turn' as const,
        payload: { text: 'again' },
      },
      {
        sessionId: 'sess-1',
        seq: 2,
        ts: 2,
        kind: 'user_turn' as const,
        payload: { text: 'out of range' },
      },
    ];
    const out = formatExplain(findings, events);
    expect(out).toContain('explanation text');
    expect(out).toContain('[0]');
    expect(out).toContain('[1]');
    expect(out).not.toContain('[2]');
  });
});
