import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@driftlock/core';
import { driftlockHome, noopLogger } from '@driftlock/core';
import { type DaemonConnection, findRunningDaemon } from './daemon-client.ts';

// `driftlock ui` (05-UI.md §4.1, and the M3 plan's item 10) — reuses an
// already-running daemon when one is reachable, otherwise spawns one
// detached and waits for it to become healthy; either way then runs the
// auth bootstrap (05-UI.md §3) and opens the browser. Port default: the
// architecture doc's "random free port by default" — `--port` only takes
// effect when this invocation is the one actually starting the daemon; it's
// ignored (with a warning) when reusing one already running elsewhere.

const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const POLL_INTERVAL_MS = 100;

export interface RunUiOptions {
  port?: number;
  logger?: Logger;
  healthCheckTimeoutMs?: number;
  /** Fire-and-forget: starts a daemon detached from this process. Overridable for tests. */
  spawnDaemon?: (opts: { port?: number; driftlockHomeDir: string }) => void;
  /** Overridable for tests — the default shells out to the OS's `open`/`start`/`xdg-open`. */
  openBrowser?: (url: string) => Promise<void>;
}

export interface RunUiResult {
  url: string;
  port: number;
  reusedExistingDaemon: boolean;
}

function lockPath(home: string): string {
  return join(home, 'ui.lock');
}

async function waitForDaemon(timeoutMs: number): Promise<DaemonConnection | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await findRunningDaemon();
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function defaultSpawnDaemon(opts: { port?: number; driftlockHomeDir: string }): void {
  const args = ['daemon', ...(opts.port !== undefined ? ['--port', String(opts.port)] : [])];
  const child = Bun.spawn({
    cmd: [process.execPath, process.argv[1] as string, ...args],
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, DRIFTLOCK_HOME: opts.driftlockHomeDir },
  });
  child.unref();
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    const proc = Bun.spawn({ cmd, stdio: ['ignore', 'ignore', 'ignore'] });
    await proc.exited;
  } catch {
    console.log(`Open this URL in your browser: ${url}`);
  }
}

/**
 * Acquires an exclusive `ui.lock` so two concurrent `driftlock ui`
 * invocations don't race to both spawn a daemon. The loser waits for the
 * winner's daemon to come up instead. A lock left behind by a launch that
 * crashed before cleaning up (so no daemon ever shows up) is treated as
 * stale after `LOCK_STALE_MS` and removed so a later invocation isn't
 * blocked forever — bounded to one retry, not an unbounded loop.
 */
async function spawnAndWait(
  home: string,
  opts: RunUiOptions,
  logger: Logger,
  allowStaleRetry = true,
): Promise<DaemonConnection> {
  const lock = lockPath(home);
  let haveLock = false;
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx' });
    haveLock = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  if (!haveLock) {
    logger.debug('another `driftlock ui` is already starting a daemon — waiting for it');
    const existing = await waitForDaemon(opts.healthCheckTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
    if (existing) return existing;
    if (allowStaleRetry) {
      const mtimeMs = statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
      const age = mtimeMs === undefined ? Number.POSITIVE_INFINITY : Date.now() - mtimeMs;
      if (age > LOCK_STALE_MS) {
        logger.warn('removing a stale ui.lock left by a launch that never completed');
        rmSync(lock, { force: true });
        return spawnAndWait(home, opts, logger, false);
      }
    }
    throw new Error(
      'timed out waiting for a concurrent `driftlock ui` to finish starting the daemon',
    );
  }

  try {
    // Re-check right after acquiring the lock: closes the narrow race where
    // the previous holder finished and removed the lock (a real success,
    // not a crash) in between our failed wait and our stale-retry.
    const alreadyUp = await findRunningDaemon();
    if (alreadyUp) return alreadyUp;

    const spawn = opts.spawnDaemon ?? defaultSpawnDaemon;
    spawn({ ...(opts.port !== undefined && { port: opts.port }), driftlockHomeDir: home });
    const started = await waitForDaemon(opts.healthCheckTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
    if (!started) throw new Error('daemon did not become healthy within the health-check timeout');
    return started;
  } finally {
    rmSync(lock, { force: true });
  }
}

export async function runUi(opts: RunUiOptions = {}): Promise<RunUiResult> {
  const logger = opts.logger ?? noopLogger;
  const home = driftlockHome();
  mkdirSync(home, { recursive: true });

  let daemon = await findRunningDaemon();
  const reusedExistingDaemon = daemon !== null;

  if (daemon && opts.port !== undefined) {
    logger.warn(
      `--port ${opts.port} ignored — reusing the daemon already running on port ${new URL(daemon.baseUrl).port}`,
    );
  }
  if (!daemon) {
    daemon = await spawnAndWait(home, opts, logger);
  }

  const bootstrapRes = await fetch(`${daemon.baseUrl}/api/bootstrap`, {
    method: 'POST',
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  if (!bootstrapRes.ok) throw new Error(`bootstrap failed: daemon returned ${bootstrapRes.status}`);
  const { nonce } = (await bootstrapRes.json()) as { nonce: string };
  const url = `${daemon.baseUrl}/?bootstrap=${nonce}`;

  const openBrowser = opts.openBrowser ?? defaultOpenBrowser;
  await openBrowser(url);

  return { url, port: Number(new URL(daemon.baseUrl).port), reusedExistingDaemon };
}
