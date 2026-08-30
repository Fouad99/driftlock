import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSpoolDb, spoolDbPath } from '@driftlock/core';
import { drainSpool } from '../src/spool.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'driftlock-daemon-spool-test-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seedSpool(envelopes: unknown[]): void {
  const db = openSpoolDb(spoolDbPath(home));
  for (const e of envelopes) db.enqueue(e as never);
  db.close();
}

describe('drainSpool', () => {
  test('returns zeros with an empty spool', async () => {
    const result = await drainSpool(home, async () => {});
    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  test('processes every valid entry and removes it', async () => {
    const envelope = {
      id: 'e1',
      agent: 'codex',
      event: 'test',
      cwd: '/repo',
      receivedAt: 1,
      payload: {},
    };
    seedSpool([envelope, { ...envelope, id: 'e2' }]);

    const handled: unknown[] = [];
    const result = await drainSpool(home, async (e) => {
      handled.push(e);
    });

    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(handled).toHaveLength(2);

    const db = openSpoolDb(spoolDbPath(home));
    expect(db.count()).toBe(0);
    db.close();
  });

  test('drops malformed entries without retrying', async () => {
    seedSpool(['not an envelope', { agent: 'codex' }]); // missing required fields

    const result = await drainSpool(home, async () => {});
    expect(result).toEqual({ processed: 0, failed: 2 });

    const db = openSpoolDb(spoolDbPath(home));
    expect(db.count()).toBe(0); // malformed entries are dropped, not kept
    db.close();
  });

  test('keeps entries that fail transiently for the next drain', async () => {
    const envelope = {
      id: 'e1',
      agent: 'codex',
      event: 'test',
      cwd: '/repo',
      receivedAt: 1,
      payload: {},
    };
    seedSpool([envelope]);

    const result = await drainSpool(home, async () => {
      throw new Error('daemon-side failure');
    });

    expect(result).toEqual({ processed: 0, failed: 1 });
    const db = openSpoolDb(spoolDbPath(home));
    expect(db.count()).toBe(1);
    db.close();
  });

  test('a concurrent enqueue during a slow drain is never lost', async () => {
    const envelope = {
      id: 'e1',
      agent: 'codex',
      event: 'first',
      cwd: '/repo',
      receivedAt: 1,
      payload: {},
    };
    seedSpool([envelope]);

    const db = openSpoolDb(spoolDbPath(home));
    let enqueuedConcurrent = false;
    const result = await drainSpool(home, async () => {
      if (enqueuedConcurrent) return; // guard: fire once, or the exhaustive drain below chases it forever
      enqueuedConcurrent = true;
      // Simulate a hook client enqueuing a new envelope while this one is being handled —
      // the old file-based drain would have clobbered this on its final write/unlink.
      db.enqueue({
        id: 'e2',
        agent: 'codex',
        event: 'concurrent',
        cwd: '/repo',
        receivedAt: 2,
        payload: {},
      } as never);
    });
    // The concurrently-enqueued entry survives the drain's internal
    // delete/overwrite operations, and — since this drain pages
    // exhaustively rather than stopping after one batch — also gets picked
    // up and applied within the same call.
    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(db.count()).toBe(0);
    db.close();
  });

  test('drains a backlog spanning multiple batches in a single call', async () => {
    const envelopes = Array.from({ length: 7 }, (_, i) => ({
      id: `e${i}`,
      agent: 'codex',
      event: 'test',
      cwd: '/repo',
      receivedAt: i,
      payload: {},
    }));
    seedSpool(envelopes);

    const handled: unknown[] = [];
    // batchSize=2 forces listPending() to be called several times to cover 7 entries.
    const result = await drainSpool(
      home,
      async (e) => {
        handled.push(e);
      },
      undefined,
      2,
    );

    expect(result).toEqual({ processed: 7, failed: 0 });
    expect(handled).toHaveLength(7);
    const db = openSpoolDb(spoolDbPath(home));
    expect(db.count()).toBe(0);
    db.close();
  });

  test('migrates leftover legacy JSONL spool files into spool.sqlite and drains them', async () => {
    const legacyDir = join(home, 'spool');
    mkdirSync(legacyDir, { recursive: true });
    const withId = {
      id: 'legacy-with-id',
      agent: 'codex',
      event: 'test',
      cwd: '/repo',
      receivedAt: 1,
      payload: { a: 1 },
    };
    // Pre-idempotency-key entries never had an `id` field — the migration
    // must synthesize one rather than reject the line as invalid.
    const withoutId = {
      agent: 'codex',
      event: 'test',
      cwd: '/repo',
      receivedAt: 2,
      payload: { b: 2 },
    };
    writeFileSync(
      join(legacyDir, 'codex.jsonl'),
      `${JSON.stringify(withId)}\n${JSON.stringify(withoutId)}\nnot valid json\n`,
    );

    const handled: unknown[] = [];
    const result = await drainSpool(home, async (e) => {
      handled.push(e);
    });

    // 2 migrated + applied; the malformed line is dropped during migration
    // itself (never enqueued), so it never reaches drainSpool's own
    // processed/failed counters.
    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(handled).toHaveLength(2);
    expect(existsSync(join(legacyDir, 'codex.jsonl'))).toBe(false); // fully migrated, file removed

    const db = openSpoolDb(spoolDbPath(home));
    expect(db.count()).toBe(0);
    db.close();
  });

  test('a whole batch failing does not loop forever — the cursor still advances to later entries', async () => {
    const failing = Array.from({ length: 3 }, (_, i) => ({
      id: `fail-${i}`,
      agent: 'codex',
      event: 'fails',
      cwd: '/repo',
      receivedAt: i,
      payload: {},
    }));
    const ok = { id: 'ok', agent: 'codex', event: 'ok', cwd: '/repo', receivedAt: 99, payload: {} };
    seedSpool([...failing, ok]);

    const handledEvents: string[] = [];
    // batchSize=3: the first batch is entirely the failing entries; without
    // cursor advancement past failures, the second listPending() call would
    // refetch the same 3 failing entries forever instead of reaching `ok`.
    const result = await drainSpool(
      home,
      async (e) => {
        handledEvents.push(e.event);
        if (e.event === 'fails') throw new Error('boom');
      },
      undefined,
      3,
    );

    expect(result).toEqual({ processed: 1, failed: 3 });
    expect(handledEvents).toContain('ok');
    const db = openSpoolDb(spoolDbPath(home));
    expect(db.count()).toBe(3); // the 3 failures remain queued for the next drain
    db.close();
  });
});
