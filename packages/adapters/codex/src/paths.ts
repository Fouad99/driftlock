import { readdirSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

// Architecture doc §5.5 — Codex sessions: ~/.codex/sessions/ (macOS/Linux),
// %USERPROFILE%\.codex\sessions\ (Windows).
export function codexSessionsDir(
  env: NodeJS.ProcessEnv = process.env,
  os: NodeJS.Platform = platform(),
): string {
  const home = os === 'win32' ? (env.USERPROFILE ?? '') : (env.HOME ?? '');
  return join(home, '.codex', 'sessions');
}

export interface SessionFile {
  path: string;
  mtimeMs: number;
}

/** Recursively lists `.jsonl` files under a directory (Codex nests sessions by date). */
export function listSessionFiles(dir: string): SessionFile[] {
  const out: SessionFile[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSessionFiles(full));
    } else if (name.endsWith('.jsonl')) {
      out.push({ path: full, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}
