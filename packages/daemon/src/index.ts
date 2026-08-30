import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { Adapter, HookEnvelope } from '@driftlock/core';
import { type RegistryStore, driftlockHome, openRegistryDb } from '@driftlock/core';
import { type WatcherMode, startCodexWatcher } from './codex-watcher.ts';
import { writeDaemonJson } from './daemon-json.ts';
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

  const token = randomUUID();
  const adapters = opts.adapters ?? {};

  const registry = openRegistryDb(`${home}/registry.sqlite`);

  const server = createServer({
    port: opts.port ?? 0,
    token,
    version: VERSION,
    adapters,
    registryDb: registry,
  });
  const port: number = server.port ?? opts.port ?? 0;

  writeDaemonJson(home, {
    port,
    pid: process.pid,
    version: VERSION,
    token,
    startedAt: Date.now(),
  });

  await drainSpool(home, (envelope) => handleHookEnvelope(envelope, adapters, registry));

  const watcher = startCodexWatcher({
    registryDb: registry,
    onModeDetected: (mode: WatcherMode) => registry.setDaemonState('codex_watch_mode', mode),
    ...(opts.onSessionProcessed && { onProcessed: opts.onSessionProcessed }),
  });

  registry.setDaemonState('pid', String(process.pid));
  registry.setDaemonState('port', String(port));
  registry.setDaemonState('version', VERSION);

  return {
    port,
    token,
    registry,
    stop: () => {
      watcher.stop();
      server.stop(true);
      registry.close();
    },
  };
}

export { createServer } from './server.ts';
export { drainSpool } from './spool.ts';
export { startCodexWatcher } from './codex-watcher.ts';
export { readDaemonJson, writeDaemonJson, daemonJsonPath, type DaemonJson } from './daemon-json.ts';
export { handleHookEnvelope } from './hook-handler.ts';
export { HookEnvelopeSchema } from './hook-envelope.ts';
export { matchRepo, processCodexSessionFile, type ProcessResult } from './process-codex-session.ts';
