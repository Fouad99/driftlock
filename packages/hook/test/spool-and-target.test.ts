import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDaemonTarget } from '../src/daemon-target.ts';
import { appendToSpool, spoolPath } from '../src/spool.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'driftlock-hook-test-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('appendToSpool', () => {
  test('creates the spool directory and appends a JSON line', () => {
    const envelope = {
      agent: 'codex' as const,
      event: 'notify',
      cwd: '/repo',
      receivedAt: 1,
      payload: {},
    };
    appendToSpool(home, envelope);
    const content = readFileSync(spoolPath(home, 'codex'), 'utf-8');
    expect(JSON.parse(content.trim())).toEqual(envelope);
  });

  test('appends multiple envelopes on separate lines', () => {
    const envelope = {
      agent: 'codex' as const,
      event: 'notify',
      cwd: '/repo',
      receivedAt: 1,
      payload: {},
    };
    appendToSpool(home, envelope);
    appendToSpool(home, { ...envelope, receivedAt: 2 });
    const lines = readFileSync(spoolPath(home, 'codex'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
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
