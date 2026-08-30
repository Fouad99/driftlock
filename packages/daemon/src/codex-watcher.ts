import {
  DEFAULT_IDLE_THRESHOLD_MS,
  type SessionFile,
  codexSessionsDir,
  isFileIdle,
  listSessionFiles,
} from '@driftlock/adapter-codex';
import type { Logger, RegistryStore } from '@driftlock/core';
import { noopLogger } from '@driftlock/core';
import chokidar, { type FSWatcher } from 'chokidar';
import { processCodexSessionFile } from './process-codex-session.ts';

// Architecture doc §4.2 — "Transcript watcher [...] Uses polling fallback
// (fs.watch unreliability differs per platform; doctor reports which mode is
// active)." Polling stays authoritative and always-correct on every OS;
// chokidar (native watchers under the hood, with a battle-tested cross-platform
// fallback story better than our own hand-rolled one) just lowers latency and,
// via `awaitWriteFinish`, avoids acting on a file mid-single-write.
//
// Two separate timescales matter here and chokidar only covers one of them:
// it tells us a *write* has settled (milliseconds), not that a Codex
// *session* is over (minutes, with long pauses between turns that would
// otherwise look like "done"). Session completion is a separate idle sweep
// below, on the poll tick — see adapter-codex's `isFileIdle`/`finalizeIfIdle`.

export type WatcherMode = 'native' | 'polling';

export interface CodexWatcherOptions {
  intervalMs?: number;
  idleThresholdMs?: number;
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
  const idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const dir = codexSessionsDir();
  const seen = new Map<string, number>(); // path -> last-synced mtimeMs
  const logger = opts.logger ?? noopLogger;

  let stopped = false;

  const process = async (file: SessionFile) => {
    try {
      const result = await processCodexSessionFile(file, opts.registryDb, logger, idleThresholdMs);
      if (result) opts.onProcessed?.(result);
    } catch (err) {
      logger.error('failed to process codex session file', {
        file: file.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Authoritative pass: catches anything a missed/late chokidar event would
  // otherwise lose, and drives idle-finalization (chokidar has no concept of
  // "nothing happened for a while").
  const scan = async () => {
    try {
      for (const file of listSessionFiles(dir)) {
        if (stopped) return;
        const prev = seen.get(file.path);
        const changed = prev === undefined || prev !== file.mtimeMs;
        seen.set(file.path, file.mtimeMs);
        if (changed || isFileIdle(file, idleThresholdMs)) {
          await process(file);
        }
      }
    } catch (err) {
      // Detached (setInterval callback) — without this catch, a thrown error
      // here becomes an unhandled rejection and the watcher silently stops
      // working with no trace anywhere.
      logger.error('codex watcher scan failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  let fsWatcher: FSWatcher | undefined;
  try {
    fsWatcher = chokidar.watch(dir, {
      persistent: true,
      ignoreInitial: true, // the initial scan() call below covers pre-existing files
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    });
    fsWatcher.on('add', (path, stats) => {
      if (stats) {
        seen.set(path, stats.mtimeMs);
        void process({ path, mtimeMs: stats.mtimeMs });
      }
    });
    fsWatcher.on('change', (path, stats) => {
      if (stats) {
        seen.set(path, stats.mtimeMs);
        void process({ path, mtimeMs: stats.mtimeMs });
      }
    });
    fsWatcher.on('error', (err) => {
      logger.error('chokidar watch error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    logger.debug('codex watcher using chokidar', { dir });
    opts.onModeDetected?.('native');
  } catch (err) {
    logger.debug('codex watcher falling back to polling only', {
      dir,
      intervalMs,
      error: err instanceof Error ? err.message : String(err),
    });
    opts.onModeDetected?.('polling');
  }

  const timer = setInterval(() => void scan(), intervalMs);
  void scan(); // initial pass so already-present sessions aren't missed

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      void fsWatcher?.close();
    },
  };
}
