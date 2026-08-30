import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RepoStore, openRepoDb } from '@driftlock/core';
import {
  finalizeIfIdle,
  isFileIdle,
  syncAndMaybeFinalize,
  syncCodexSessionFile,
} from '../src/ingest.ts';
import type { SessionFile } from '../src/paths.ts';

const FIXTURE_1 = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'codex',
  'session-1.jsonl',
);
const FIXTURE_2 = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'codex',
  'session-2.jsonl',
);

let dir: string;
let repoDb: RepoStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driftlock-codex-ingest-test-'));
  repoDb = openRepoDb(join(dir, 'repo.sqlite'));
});

afterEach(() => {
  repoDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('isFileIdle', () => {
  test('true once elapsed time reaches the threshold', () => {
    const file: SessionFile = { path: '/x', mtimeMs: 1000 };
    expect(isFileIdle(file, 500, /* now */ 1500)).toBe(true);
    expect(isFileIdle(file, 500, /* now */ 1499)).toBe(false);
  });
});

describe('syncCodexSessionFile', () => {
  test('creates a session and its events on first sync', async () => {
    const file: SessionFile = { path: FIXTURE_1, mtimeMs: Date.now() };
    const result = await syncCodexSessionFile(file, '/repo', repoDb);
    expect(result).not.toBeNull();
    expect(result?.isNewSession).toBe(true);

    const session = repoDb.getSession(result?.sessionId as string);
    expect(session?.agent).toBe('codex');
    expect(session?.endedAt).toBeNull(); // sync never finalizes on its own
    expect(repoDb.getEvents(result?.sessionId as string).length).toBeGreaterThan(0);
  });

  test('re-syncing an open session replaces its events instead of duplicating them', async () => {
    const file: SessionFile = { path: FIXTURE_1, mtimeMs: Date.now() };
    const first = await syncCodexSessionFile(file, '/repo', repoDb);
    const firstCount = repoDb.getEvents(first?.sessionId as string).length;

    const second = await syncCodexSessionFile(file, '/repo', repoDb);
    expect(second?.sessionId).toBe(first?.sessionId);
    expect(second?.isNewSession).toBe(false);
    // Same file content re-parsed: same event count, not doubled.
    expect(repoDb.getEvents(second?.sessionId as string).length).toBe(firstCount);
  });

  test('a finalized session with no new content is never re-touched', async () => {
    const file: SessionFile = { path: FIXTURE_1, mtimeMs: 1000 };
    const first = await syncCodexSessionFile(file, '/repo', repoDb);
    const sessionId = first?.sessionId as string;
    repoDb.endSession(sessionId, 2000, 'idle'); // finalized "as of" mtime 2000

    // Same file, mtime still <= what we finalized at — genuinely nothing new.
    const result = await syncCodexSessionFile(file, '/repo', repoDb);
    expect(result).toBeNull();
  });

  test('a finalized session whose file grew again is reopened and re-synced, not permanently dropped', async () => {
    const file: SessionFile = { path: FIXTURE_1, mtimeMs: 1000 };
    const first = await syncCodexSessionFile(file, '/repo', repoDb);
    const sessionId = first?.sessionId as string;
    repoDb.endSession(sessionId, 1000, 'idle'); // finalized "as of" mtime 1000 (a wrong guess — a pause, not the end)

    // The transcript kept growing after the idle guess — mtime moved past what we finalized at.
    const grownFile: SessionFile = { path: FIXTURE_1, mtimeMs: 5000 };
    const result = await syncCodexSessionFile(grownFile, '/repo', repoDb);

    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe(sessionId);
    expect(repoDb.getSession(sessionId)?.endedAt).toBeNull(); // reopened, not silently skipped
  });

  test('a malformed transcript is rejected atomically — nothing is left half-persisted', async () => {
    const badPath = join(dir, 'bad.jsonl');
    writeFileSync(
      badPath,
      [
        '{"type":"session_meta","id":"sess_bad","timestamp":"2026-08-22T11:00:00.000Z","cwd":"/repo"}',
        '{"type":"response_item","timestamp":"2026-08-22T11:00:02.000Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}',
        '{"type":"response_item", this is not valid json', // simulates a line caught mid-write
      ].join('\n'),
    );

    const result = await syncCodexSessionFile(
      { path: badPath, mtimeMs: Date.now() },
      '/repo',
      repoDb,
    );
    expect(result).toBeNull();
    expect(repoDb.getSessionByAgentSession('codex', 'sess_bad')).toBeNull();
  });
});

describe('finalizeIfIdle', () => {
  test('ends the session once its file has gone idle', async () => {
    const file: SessionFile = { path: FIXTURE_1, mtimeMs: 1000 };
    const synced = await syncCodexSessionFile(file, '/repo', repoDb);
    const sessionId = synced?.sessionId as string;

    expect(finalizeIfIdle(file, sessionId, repoDb, 500, /* now */ 1000)).toBe(false); // not idle yet
    expect(repoDb.getSession(sessionId)?.endedAt).toBeNull();

    expect(finalizeIfIdle(file, sessionId, repoDb, 500, /* now */ 1600)).toBe(true);
    expect(repoDb.getSession(sessionId)?.endedAt).toBe(1000);
    expect(repoDb.getSession(sessionId)?.endReason).toBe('idle');
  });

  test('is a no-op on an already-ended session', async () => {
    const file: SessionFile = { path: FIXTURE_1, mtimeMs: 1000 };
    const synced = await syncCodexSessionFile(file, '/repo', repoDb);
    const sessionId = synced?.sessionId as string;
    repoDb.endSession(sessionId, 999, 'stop');

    expect(finalizeIfIdle(file, sessionId, repoDb, 0, 100000)).toBe(false);
    expect(repoDb.getSession(sessionId)?.endReason).toBe('stop'); // untouched
  });
});

describe('syncAndMaybeFinalize', () => {
  test('does not finalize a fresh, non-idle sync', async () => {
    const file: SessionFile = { path: FIXTURE_2, mtimeMs: Date.now() };
    const result = await syncAndMaybeFinalize(file, '/repo', repoDb, { idleThresholdMs: 60_000 });
    expect(result?.finalized).toBe(false);
    expect(repoDb.getSession(result?.sessionId as string)?.endedAt).toBeNull();
  });

  test('finalizes immediately when the file already looks idle', async () => {
    const file: SessionFile = { path: FIXTURE_2, mtimeMs: Date.now() - 10_000 };
    const result = await syncAndMaybeFinalize(file, '/repo', repoDb, { idleThresholdMs: 100 });
    expect(result?.finalized).toBe(true);
    expect(repoDb.getSession(result?.sessionId as string)?.endedAt).not.toBeNull();
  });
});
