import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { Adapter, HookEnvelope, LogLevel, Logger } from '@driftlock/core';
import {
  type RegistryStore,
  createConsoleSink,
  createFileSink,
  createLogger,
  driftlockHome,
  openRegistryDb,
} from '@driftlock/core';
import { type WatcherMode, startCodexWatcher } from './codex-watcher.ts';
import { daemonLogPath, writeDaemonJson } from './daemon-json.ts';
import { handleHookEnvelope } from './hook-handler.ts';
import type { ProcessResult } from './process-codex-session.ts';
import { createServer } from './server.ts';
import { drainSpool } from './spool.ts';

const VERSION = '0.0.0';

export interface DaemonOptions {
  port?: number;
  driftlockHomeDir?: string;
  adapters?: Partial<Record<HookEnvelope['agent'], Adapter>>;
  onSessionProcessed?: (result: ProcessResult) => void;
  /** Overrides the default file+console logger — mainly for tests that want it quiet. */
  logger?: Logger;
  logLevel?: LogLevel;
  /** How long a Codex transcript must stop changing before its session is considered ended. Mainly for tests. */
  codexIdleThresholdMs?: number;
  codexWatchIntervalMs?: number;
}

export interface DaemonHandle {
  port: number;
  token: string;
  registry: RegistryStore;
  stop: () => void;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const home = opts.driftlockHomeDir ?? driftlockHome();
  mkdirSync(home, { recursive: true });

  // Real usage always wants both: `daemon.log` (usage doc's documented file,
  // previously never written) and console output since there's no
  // background/service-install mode yet (M7) — `driftlock daemon` is always
  // foreground. Tests override with a noop or collecting logger.
  const logger =
    opts.logger ??
    createLogger({
      component: 'daemon',
      sinks: [createFileSink(daemonLogPath(home)), createConsoleSink()],
      level: opts.logLevel ?? 'info',
    });

  const token = randomUUID();
  const adapters = opts.adapters ?? {};

  const registry = openRegistryDb(`${home}/registry.sqlite`);

  // Drained before the HTTP listener starts (or daemon.json is published)
  // so a hook client can't discover the daemon and deliver a live event
  // mid-drain — a live SessionStart racing a still-spooled, older
  // SessionStart for the same session could otherwise be claimed and
  // discarded as "nothing applied" before the spooled one ever gets a
  // chance to establish the session.
  const drainResult = await drainSpool(
    home,
    (envelope) => handleHookEnvelope(envelope, adapters, registry, logger.child('hook')),
    logger.child('spool'),
  );

  const server = createServer({
    port: opts.port ?? 0,
    token,
    version: VERSION,
    adapters,
    registryDb: registry,
    logger: logger.child('server'),
  });
  const port: number = server.port ?? opts.port ?? 0;

  writeDaemonJson(home, {
    port,
    pid: process.pid,
    version: VERSION,
    token,
    startedAt: Date.now(),
  });

  const watcher = startCodexWatcher({
    registryDb: registry,
    logger: logger.child('watcher'),
    onModeDetected: (mode: WatcherMode) => registry.setDaemonState('codex_watch_mode', mode),
    ...(opts.onSessionProcessed && { onProcessed: opts.onSessionProcessed }),
    ...(opts.codexIdleThresholdMs !== undefined && { idleThresholdMs: opts.codexIdleThresholdMs }),
    ...(opts.codexWatchIntervalMs !== undefined && { intervalMs: opts.codexWatchIntervalMs }),
  });

  registry.setDaemonState('pid', String(process.pid));
  registry.setDaemonState('port', String(port));
  registry.setDaemonState('version', VERSION);

  logger.info('daemon started', {
    port,
    pid: process.pid,
    version: VERSION,
    spoolDrained: drainResult.processed,
  });

  return {
    port,
    token,
    registry,
    stop: () => {
      logger.info('daemon stopping');
      watcher.stop();
      server.stop(true);
      registry.close();
    },
  };
}

export { createServer } from './server.ts';
export { drainSpool } from './spool.ts';
export { startCodexWatcher } from './codex-watcher.ts';
export { analyzeAndStore } from './analyze-and-store.ts';
export {
  readDaemonJson,
  writeDaemonJson,
  daemonJsonPath,
  daemonLogPath,
  type DaemonJson,
} from './daemon-json.ts';
export { handleHookEnvelope } from './hook-handler.ts';
export { HookEnvelopeSchema } from './hook-envelope.ts';
export { matchRepo, processCodexSessionFile, type ProcessResult } from './process-codex-session.ts';
