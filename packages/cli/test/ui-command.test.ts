import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DaemonHandle, startDaemon } from '@driftlock/daemon';
import { runUi } from '../src/ui-command.ts';

let base: string;
let home: string;
let originalDriftlockHome: string | undefined;
let daemon: DaemonHandle | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'driftlock-ui-command-test-'));
  home = join(base, 'driftlock-home');
  originalDriftlockHome = process.env.DRIFTLOCK_HOME;
  process.env.DRIFTLOCK_HOME = home;
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  daemon?.stop();
  daemon = undefined;
  // biome-ignore lint/performance/noDelete: assigning `undefined` would stringify to "undefined" and break the restore
  if (originalDriftlockHome === undefined) delete process.env.DRIFTLOCK_HOME;
  else process.env.DRIFTLOCK_HOME = originalDriftlockHome;
  rmSync(base, { recursive: true, force: true });
});

describe('runUi — reusing an already-running daemon', () => {
  test('reuses it, does not spawn, and opens the bootstrap URL', async () => {
    daemon = await startDaemon({ driftlockHomeDir: home });
    let spawnCalled = false;
    let openedUrl: string | undefined;

    const result = await runUi({
      spawnDaemon: () => {
        spawnCalled = true;
      },
      openBrowser: async (url) => {
        openedUrl = url;
      },
    });

    expect(spawnCalled).toBe(false);
    expect(result.reusedExistingDaemon).toBe(true);
    expect(result.port).toBe(daemon.port);
    expect(openedUrl).toContain(`127.0.0.1:${daemon.port}/?bootstrap=`);
  });

  test('warns and ignores --port when reusing an existing daemon', async () => {
    daemon = await startDaemon({ driftlockHomeDir: home });
    const warnings: string[] = [];

    const result = await runUi({
      port: 59999,
      spawnDaemon: () => {
        throw new Error('should not spawn when reusing');
      },
      openBrowser: async () => {},
      logger: {
        debug() {},
        info() {},
        warn: (msg: string) => warnings.push(msg),
        error() {},
        child: () => ({
          debug() {},
          info() {},
          warn: (msg: string) => warnings.push(msg),
          error() {},
          child(): never {
            throw new Error('unused');
          },
        }),
      },
    });

    expect(result.port).toBe(daemon.port);
    expect(warnings.some((w) => w.includes('--port 59999 ignored'))).toBe(true);
  });
});

describe('runUi — no daemon running', () => {
  test('spawns one (via the injected spawn) and waits for it to become healthy', async () => {
    let spawnCalled = false;
    const result = await runUi({
      spawnDaemon: () => {
        spawnCalled = true;
        // Simulate a real spawned daemon writing daemon.json once healthy.
        void startDaemon({ driftlockHomeDir: home }).then((d) => {
          daemon = d;
        });
      },
      openBrowser: async () => {},
    });

    expect(spawnCalled).toBe(true);
    expect(result.reusedExistingDaemon).toBe(false);
    expect(daemon).toBeDefined();
    expect(result.port).toBe(daemon?.port);
  });

  test('throws if the spawned daemon never becomes healthy within the timeout', async () => {
    await expect(
      runUi({
        spawnDaemon: () => {
          /* never actually starts anything */
        },
        openBrowser: async () => {},
        healthCheckTimeoutMs: 200,
      }),
    ).rejects.toThrow(/did not become healthy/);
  });
});

describe('runUi — concurrent launch protection', () => {
  test('a second invocation racing the lock waits for the first instead of spawning its own', async () => {
    let spawnCount = 0;
    const first = runUi({
      spawnDaemon: () => {
        spawnCount += 1;
        void startDaemon({ driftlockHomeDir: home }).then((d) => {
          daemon = d;
        });
      },
      openBrowser: async () => {},
    });
    // Give the first call a moment to win the lock before the second starts.
    await new Promise((r) => setTimeout(r, 10));
    const second = runUi({
      spawnDaemon: () => {
        spawnCount += 1;
      },
      openBrowser: async () => {},
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(spawnCount).toBe(1);
    expect(firstResult.port).toBe(secondResult.port);
  });

  test('a stale lock (no daemon ever showed up) is removed so a later launch is not blocked forever', async () => {
    writeFileSync(join(home, 'ui.lock'), '999999');
    // Back-date it well past the staleness threshold.
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(home, 'ui.lock'), past, past);

    let spawnCalled = false;
    const result = await runUi({
      spawnDaemon: () => {
        spawnCalled = true;
        void startDaemon({ driftlockHomeDir: home }).then((d) => {
          daemon = d;
        });
      },
      openBrowser: async () => {},
      healthCheckTimeoutMs: 2000,
    });

    expect(spawnCalled).toBe(true);
    expect(result.reusedExistingDaemon).toBe(false);
  });
});

describe('runUi — bootstrap', () => {
  test('the opened URL redeems a single-use nonce that sets the session cookie', async () => {
    daemon = await startDaemon({ driftlockHomeDir: home });
    let openedUrl: string | undefined;
    await runUi({
      spawnDaemon: () => {
        throw new Error('should not spawn');
      },
      openBrowser: async (url) => {
        openedUrl = url;
      },
    });

    const res = await fetch(openedUrl as string, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toContain('driftlock_session=');
  });
});
