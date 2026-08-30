import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSpoolDb, spoolDbPath } from '@driftlock/core';
import { readDaemonTarget } from '../src/daemon-target.ts';
import { appendToSpool } from '../src/spool.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'driftlock-hook-test-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('appendToSpool', () => {
  test('enqueues an envelope into spool.sqlite', () => {
    const envelope = {
      id: 'e1',
      agent: 'codex' as const,
      event: 'notify',
      cwd: '/repo',
      receivedAt: 1,
      payload: {},
    };
    appendToSpool(home, envelope);

    const db = openSpoolDb(spoolDbPath(home));
    const pending = db.listPending();
    db.close();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.envelope).toEqual(envelope);
  });

  test('enqueues multiple envelopes as separate entries, oldest first', () => {
    const envelope = {
      id: 'e1',
      agent: 'codex' as const,
      event: 'notify',
      cwd: '/repo',
      receivedAt: 1,
      payload: {},
    };
    appendToSpool(home, envelope);
    appendToSpool(home, { ...envelope, receivedAt: 2 });

    const db = openSpoolDb(spoolDbPath(home));
    const pending = db.listPending();
    db.close();
    expect(pending).toHaveLength(2);
    expect((pending[0]?.envelope as typeof envelope).receivedAt).toBe(1);
    expect((pending[1]?.envelope as typeof envelope).receivedAt).toBe(2);
  });
});

describe('readDaemonTarget', () => {
  test('returns null when daemon.json is missing', () => {
    expect(readDaemonTarget(home)).toBeNull();
  });

  test('returns null for a malformed daemon.json', () => {
    writeFileSync(join(home, 'daemon.json'), '{"port": "not a number"}');
    expect(readDaemonTarget(home)).toBeNull();
  });

  test('reads port and token from a valid daemon.json', () => {
    writeFileSync(
      join(home, 'daemon.json'),
      JSON.stringify({ port: 4711, token: 'abc', pid: 1, version: '0', startedAt: 0 }),
    );
    expect(readDaemonTarget(home)).toEqual({ port: 4711, token: 'abc' });
  });
});
