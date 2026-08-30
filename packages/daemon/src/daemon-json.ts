import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Architecture doc §4.2/§10 — `<driftlock-home>/daemon.json`: port, pid,
// version, local auth token (A-17). Hook client and CLI read this to find
// the running daemon; the CLI falls back to reading DBs directly if it's
// missing or stale.

export interface DaemonJson {
  port: number;
  pid: number;
  version: string;
  token: string;
  startedAt: number;
}

export function daemonJsonPath(driftlockHomeDir: string): string {
  return join(driftlockHomeDir, 'daemon.json');
}

export function writeDaemonJson(driftlockHomeDir: string, info: DaemonJson): void {
  writeFileSync(daemonJsonPath(driftlockHomeDir), `${JSON.stringify(info, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function readDaemonJson(driftlockHomeDir: string): DaemonJson | null {
  try {
    return JSON.parse(readFileSync(daemonJsonPath(driftlockHomeDir), 'utf-8')) as DaemonJson;
  } catch {
    return null;
  }
}
