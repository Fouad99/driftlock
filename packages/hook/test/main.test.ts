import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/index.ts';
import { spoolPath } from '../src/spool.ts';

let home: string;
let originalDriftlockHome: string | undefined;
let fakeDaemon: ReturnType<typeof Bun.serve> | undefined;
const TOKEN = 'test-token';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'driftlock-hook-main-test-'));
  originalDriftlockHome = process.env.DRIFTLOCK_HOME;
  process.env.DRIFTLOCK_HOME = home;
});

afterEach(() => {
  fakeDaemon?.stop(true);
  fakeDaemon = undefined;
  if (originalDriftlockHome === undefined) {
    // biome-ignore lint/performance/noDelete: assigning undefined would stringify to "undefined"
    delete process.env.DRIFTLOCK_HOME;
  } else {
    process.env.DRIFTLOCK_HOME = originalDriftlockHome;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('main', () => {
  test('exits 0 and prints usage when agent/event are missing', async () => {
    const code = await main([], '{}');
    expect(code).toBe(0);
  });

  test('spools and exits 0 when no daemon is reachable', async () => {
    const code = await main(['codex', 'notify'], '{}');
    expect(code).toBe(0);
    expect(existsSync(spoolPath(home, 'codex'))).toBe(true);
  });

  test('with --wait, prints the daemon response body to stdout', async () => {
    fakeDaemon = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ ok: true, handled: false, note: 'hi' }),
    });
    writeFileSync(
      join(home, 'daemon.json'),
      JSON.stringify({ port: fakeDaemon.port, token: TOKEN, pid: 1, version: '0', startedAt: 0 }),
    );

    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = ((chunk: string) => {
      captured += chunk;
      return true;
    }) as typeof process.stdout.write;

    try {
      const code = await main(['codex', 'notify', '--wait'], '{}');
      expect(code).toBe(0);
      expect(JSON.parse(captured)).toEqual({ ok: true, handled: false, note: 'hi' });
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
