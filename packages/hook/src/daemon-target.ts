import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Deliberately not importing `@driftlock/daemon` — the hook client shares no
// code with the daemon beyond the envelope shape (A-16 rationale: it must be
// independently portable, even rewritable in Go, without touching the
// daemon). This is a minimal local read of the same `daemon.json` file.

export interface DaemonTarget {
  port: number;
  token: string;
}

export function readDaemonTarget(driftlockHomeDir: string): DaemonTarget | null {
  try {
    const raw = readFileSync(join(driftlockHomeDir, 'daemon.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { port?: unknown; token?: unknown };
    if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') return null;
    return { port: parsed.port, token: parsed.token };
  } catch {
    return null;
  }
}
