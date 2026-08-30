import { type FSWatcher, watch } from 'node:fs';
import { type SessionFile, codexSessionsDir, listSessionFiles } from '@driftlock/adapter-codex';
import type { Logger, RegistryStore } from '@driftlock/core';
import { noopLogger } from '@driftlock/core';
import { processCodexSessionFile } from './process-codex-session.ts';

// Architecture doc §4.2 — "Transcript watcher [...] Uses polling fallback
// (fs.watch unreliability differs per platform; doctor reports which mode is
// active)." Polling is the authoritative, always-correct path on every OS;
// a best-effort native `fs.watch(recursive)` just makes new sessions show up
// faster where the platform supports it (macOS, Windows) — its absence never
// loses anything, since the next poll tick always covers it.

export type WatcherMode = 'native' | 'polling';

export interface CodexWatcherOptions {
  intervalMs?: number;
  registryDb: RegistryStore;
  onProcessed?: (result: NonNullable<Awaited<ReturnType<typeof processCodexSessionFile>>>) => void;
  onModeDetected?: (mode: WatcherMode) => void;
  logger?: Logger;
}

export interface CodexWatcherHandle {
  stop: () => void;
}

export function startCodexWatcher(opts: CodexWatcherOptions): CodexWatcherHandle {
  const intervalMs = opts.intervalMs ?? 2000;
  const dir = codexSessionsDir();
  const seen = new Map<string, number>(); // path -> mtimeMs
  const logger = opts.logger ?? noopLogger;

  let stopped = false;

  const scan = async () => {
    try {
      const files = listSessionFiles(dir);
      const changed: SessionFile[] = [];
      for (const file of files) {
        const prev = seen.get(file.path);
        if (prev === undefined || prev !== file.mtimeMs) {
          changed.push(file);
        }
        seen.set(file.path, file.mtimeMs);
      }
      if (changed.length === 0) return;

      for (const file of changed) {
        if (stopped) return;
        const result = await processCodexSessionFile(file, opts.registryDb, logger);
        if (result) opts.onProcessed?.(result);
      }
    } catch (err) {
      // This runs detached (setInterval / fs.watch callback) — without this
      // catch, a thrown error here becomes an unhandled rejection and the
      // watcher silently stops working with no trace anywhere.
      logger.error('codex watcher scan failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  let fsWatcher: FSWatcher | undefined;
  try {
    fsWatcher = watch(dir, { recursive: true }, () => {
      void scan();
    });
    logger.debug('codex watcher using native fs.watch', { dir });
    opts.onModeDetected?.('native');
  } catch {
    logger.debug('codex watcher falling back to polling only', { dir, intervalMs });
    opts.onModeDetected?.('polling');
  }

  const timer = setInterval(() => void scan(), intervalMs);
  void scan(); // initial pass so already-present sessions aren't missed

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      fsWatcher?.close();
    },
  };
}
