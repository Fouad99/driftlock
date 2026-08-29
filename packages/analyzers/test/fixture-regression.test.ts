import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CodexAdapter } from '@driftlock/adapter-codex';
import type { AdapterOutput, Event, RepoRef, Session } from '@driftlock/core';
import { loopAnalyzer } from '../src/loop.ts';
import { testBeforeClaimAnalyzer } from '../src/test-before-claim.ts';

async function loadFixture(fixture: string): Promise<{ session: Session; events: Event[] }> {
  const adapter = new CodexAdapter();
  const repo: RepoRef = { root: '/repo', repoId: 'repo-1' };
  const path = join(import.meta.dir, '..', '..', '..', 'fixtures', 'codex', fixture);
  const outputs: AdapterOutput[] = [];
  for await (const output of adapter.parseTranscript({ path, repoRoot: '/repo' }, { repo })) {
    outputs.push(output);
  }
  const start = outputs.find((o) => o.kind === 'session_start');
  const evs = outputs.find((o) => o.kind === 'events');
  if (start?.kind !== 'session_start' || evs?.kind !== 'events')
    throw new Error('bad fixture output');

  const session: Session = {
    id: start.session.id ?? 'fixture',
    agent: start.session.agent,
    agentSession: start.session.agentSession,
    repoRoot: start.session.repoRoot,
    branch: start.session.branch,
    headBefore: start.session.headBefore,
    headAfter: start.session.headAfter,
    startedAt: start.session.startedAt,
    endedAt: null,
    endReason: null,
    taskText: start.session.taskText,
    tokenIn: start.session.tokenIn,
    tokenOut: start.session.tokenOut,
    costUsd: start.session.costUsd,
    source: start.session.source,
  };
  const events = evs.events.map((e, i) => ({ ...e, seq: i })) as Event[];
  return { session, events };
}

describe('real-session regression: codex fixtures', () => {
  test('loop analyzer flags the edit/test loop in session-2', async () => {
    const { session, events } = await loadFixture('session-2.jsonl');
    const findings = await loopAnalyzer.run({ session, events, previousFindings: [] });
    expect(findings.some((f) => f.title.includes('edit/test cycles'))).toBe(true);
  });

  test('test_before_claim does not fire on session-1 (test ran, then it claimed done)', async () => {
    const { session, events } = await loadFixture('session-1.jsonl');
    const findings = await testBeforeClaimAnalyzer.run({ session, events, previousFindings: [] });
    expect(findings).toHaveLength(0);
  });
});
