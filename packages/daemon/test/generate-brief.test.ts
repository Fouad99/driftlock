import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RepoStore, openRepoDb } from '@driftlock/core';
import { generateBrief } from '../src/generate-brief.ts';

let dir: string;
let repoDb: RepoStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driftlock-generate-brief-test-'));
  repoDb = openRepoDb(join(dir, 'repo.sqlite'));
});

afterEach(() => {
  repoDb.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedSession(overrides: { endedAt?: number | null } = {}): string {
  const session = repoDb.createSession({
    agent: 'codex',
    agentSession: null,
    repoRoot: dir,
    branch: null,
    headBefore: null,
    headAfter: null,
    startedAt: 1000,
    taskText: null,
    tokenIn: null,
    tokenOut: null,
    costUsd: null,
    source: 'transcript',
  });
  if (overrides.endedAt !== null) {
    repoDb.endSession(session.id, overrides.endedAt ?? 2000, 'stop');
  }
  return session.id;
}

describe('generateBrief', () => {
  test('does nothing for a session that has not ended', async () => {
    const sessionId = seedSession({ endedAt: null });
    await generateBrief(sessionId, dir, repoDb);
    expect(repoDb.getBrief(sessionId)).toBeNull();
  });

  test('does nothing for a missing session id', async () => {
    await generateBrief('no-such-session', dir, repoDb);
    expect(repoDb.getLatestBrief()).toBeNull();
  });

  test('generates and stores a brief for an ended session, and writes the fenced blocks', async () => {
    const sessionId = seedSession();
    repoDb.appendEvents(sessionId, [
      { sessionId, ts: 1001, kind: 'user_turn', payload: { text: 'add rate limiting' } },
      {
        sessionId,
        ts: 1002,
        kind: 'plan_item',
        payload: { id: '1', text: 'write the limiter', status: 'in_progress' },
      },
    ]);

    await generateBrief(sessionId, dir, repoDb);

    const brief = repoDb.getBrief(sessionId);
    expect(brief).not.toBeNull();
    expect(brief?.markdown).toContain('# Resume brief');
    expect(brief?.markdown).toContain('write the limiter');
    expect(brief?.markdown).toContain('## Next task');
    expect(brief?.markdown).toContain('add rate limiting');
    expect(repoDb.getLatestBrief()?.sessionId).toBe(sessionId);

    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toContain('write the limiter');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toContain('write the limiter');
  });

  test('falls back to the last agent_turn when there are no plan_items', async () => {
    const sessionId = seedSession();
    repoDb.appendEvents(sessionId, [
      { sessionId, ts: 1001, kind: 'agent_turn', payload: { text: 'implemented the fix' } },
    ]);

    await generateBrief(sessionId, dir, repoDb);

    expect(repoDb.getBrief(sessionId)?.markdown).toContain('implemented the fix');
  });

  test('lists unresolved findings and omits resolved ones', async () => {
    const sessionId = seedSession();
    const finding = repoDb.createFinding({
      sessionId,
      analyzer: 'loop',
      severity: 'warn',
      title: 'stuck in a loop',
      explanation: 'edited the same file 3 times',
      fromSeq: null,
      toSeq: null,
      data: null,
    });

    await generateBrief(sessionId, dir, repoDb);
    expect(repoDb.getBrief(sessionId)?.markdown).toContain('stuck in a loop');

    repoDb.resolveFinding(finding.id);
    await generateBrief(sessionId, dir, repoDb);
    expect(repoDb.getBrief(sessionId)?.markdown).not.toContain('stuck in a loop');
  });

  test('every pinned finding survives even when there are more than MAX_FINDINGS (10) of them', async () => {
    const sessionId = seedSession();
    const pinnedIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const f = repoDb.createFinding({
        sessionId,
        analyzer: 'loop',
        severity: 'warn',
        title: `pinned finding ${i}`,
        explanation: 'x',
        fromSeq: null,
        toSeq: null,
        data: null,
      });
      repoDb.setFindingPinned(f.id, true);
      pinnedIds.push(f.id);
    }

    await generateBrief(sessionId, dir, repoDb);
    const markdown = repoDb.getBrief(sessionId)?.markdown ?? '';
    for (let i = 0; i < 12; i++) {
      expect(markdown).toContain(`pinned finding ${i}`);
    }
  });

  test('pinned findings never crowd out entirely, but unpinned ones still fill the remaining budget', async () => {
    const sessionId = seedSession();
    const pinned = repoDb.createFinding({
      sessionId,
      analyzer: 'loop',
      severity: 'warn',
      title: 'pinned one',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });
    repoDb.setFindingPinned(pinned.id, true);
    for (let i = 0; i < 15; i++) {
      repoDb.createFinding({
        sessionId,
        analyzer: 'loop',
        severity: 'info',
        title: `unpinned finding ${i}`,
        explanation: 'x',
        fromSeq: null,
        toSeq: null,
        data: null,
      });
    }

    await generateBrief(sessionId, dir, repoDb);
    const markdown = repoDb.getBrief(sessionId)?.markdown ?? '';
    expect(markdown).toContain('pinned one');
    // MAX_FINDINGS is 10: the pin takes one slot, 9 of the 15 unpinned fill the rest —
    // the brief still respects its overall budget for non-pinned findings.
    expect(markdown).toContain('## Unresolved findings (10)');
    // Exact match via a trailing word boundary — "unpinned finding 1" is
    // otherwise a substring of "unpinned finding 14" and double-counts.
    const unpinnedMentioned = Array.from({ length: 15 }, (_, i) => i).filter((i) =>
      new RegExp(`unpinned finding ${i}\\b`).test(markdown),
    );
    expect(unpinnedMentioned).toHaveLength(9);
  });

  test('is safe to call twice — upserts rather than duplicating', async () => {
    const sessionId = seedSession();
    await generateBrief(sessionId, dir, repoDb);
    await generateBrief(sessionId, dir, repoDb);
    // upsertBrief is keyed on session_id — a second call replaces, not appends.
    expect(repoDb.getBrief(sessionId)).not.toBeNull();
  });
});
