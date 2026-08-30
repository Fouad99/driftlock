import { type FSWatcher, watch } from 'node:fs';
import { type SessionFile, codexSessionsDir, listSessionFiles } from '@driftlock/adapter-codex';
import type { RegistryStore } from '@driftlock/core';
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
}

export interface CodexWatcherHandle {
  stop: () => void;
}

export function startCodexWatcher(opts: CodexWatcherOptions): CodexWatcherHandle {
  const intervalMs = opts.intervalMs ?? 2000;
  const dir = codexSessionsDir();
  const seen = new Map<string, number>(); // path -> mtimeMs

  let stopped = false;

  const scan = async () => {
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
      const result = await processCodexSessionFile(file, opts.registryDb);
      if (result) opts.onProcessed?.(result);
    }
  };

  let fsWatcher: FSWatcher | undefined;
  try {
    fsWatcher = watch(dir, { recursive: true }, () => {
      void scan();
    });
    opts.onModeDetected?.('native');
  } catch {
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
