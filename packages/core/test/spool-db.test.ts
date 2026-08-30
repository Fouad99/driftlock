import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookEnvelope } from '../src/interfaces/adapter.ts';
import { type SpoolStore, openSpoolDb } from '../src/store/spool-db.ts';

let dir: string;
let db: SpoolStore;

function envelope(id: string): HookEnvelope {
  return { id, agent: 'codex', event: 'test', cwd: '/repo', receivedAt: 1, payload: {} };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driftlock-spool-db-test-'));
  db = openSpoolDb(join(dir, 'spool.sqlite'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SpoolStore', () => {
  test('enqueue/listPending/remove/count round-trip', () => {
    expect(db.count()).toBe(0);
    db.enqueue(envelope('a'));
    db.enqueue(envelope('b'));
    expect(db.count()).toBe(2);

    const pending = db.listPending();
    expect(pending).toHaveLength(2);
    expect((pending[0]?.envelope as HookEnvelope).id).toBe('a'); // oldest first

    db.remove(pending[0]?.id as number);
    expect(db.count()).toBe(1);
  });

  test('listPending(limit) caps the batch size', () => {
    for (let i = 0; i < 5; i++) db.enqueue(envelope(`e${i}`));
    expect(db.listPending(2)).toHaveLength(2);
  });

  test('listPending(limit, afterId) pages past already-seen rows regardless of whether they were removed', () => {
    for (let i = 0; i < 5; i++) db.enqueue(envelope(`e${i}`));
    const first = db.listPending(2, 0);
    expect(first.map((e) => (e.envelope as HookEnvelope).id)).toEqual(['e0', 'e1']);

    // Don't remove them (simulating entries that failed and were left in
    // place) — the cursor must still move past them, not refetch forever.
    const lastId = first[first.length - 1]?.id as number;
    const second = db.listPending(2, lastId);
    expect(second.map((e) => (e.envelope as HookEnvelope).id)).toEqual(['e2', 'e3']);
  });
});
