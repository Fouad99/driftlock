import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstallResult, RepoRef } from '@driftlock/core';

// Usage doc §"Set up a repository" — "Claude Code → .claude/settings.json
// (SessionStart, UserPromptSubmit, PostToolUse, PreCompact, Stop)". Config
// shape verified against https://code.claude.com/docs/en/hooks: each event
// maps to an array of `{matcher, hooks: [{type, command, args}]}` groups.
//
// `PreToolUse` (drift verdicts) isn't wired here — that's M6, and per the
// implementation plan's milestone ordering it stays off until then.
const HOOKED_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'PreCompact',
  'Stop',
] as const;

const HOOK_COMMAND = 'driftlock-hook';

// M2 §8.1 — SessionStart is the one event driftlock needs a synchronous
// reply from (the resume brief, injected as `additionalContext`), so it's
// the only event wired with `--wait` (the hook client only prints the
// daemon's response when this flag is present) and an `additionalContextLimit`
// (keeps the injected brief under Claude Code's context-spill threshold).
const ADDITIONAL_CONTEXT_LIMIT = 2000;

interface HookEntry {
  type: string;
  command: string;
  args?: string[];
  additionalContextLimit?: number;
}
interface MatcherGroup {
  matcher?: string;
  hooks: HookEntry[];
}
interface ClaudeSettings {
  hooks?: Record<string, MatcherGroup[]>;
  [key: string]: unknown;
}

function settingsPath(repoRoot: string): string {
  return join(repoRoot, '.claude', 'settings.json');
}

/** Same driftlock entry, same effective config — nothing to rewrite. */
function entryMatches(existing: HookEntry, desired: HookEntry): boolean {
  return (
    existing.command === desired.command &&
    JSON.stringify(existing.args ?? []) === JSON.stringify(desired.args ?? []) &&
    (existing.additionalContextLimit ?? null) === (desired.additionalContextLimit ?? null)
  );
}

function hookEntry(event: (typeof HOOKED_EVENTS)[number]): HookEntry {
  if (event === 'SessionStart') {
    return {
      type: 'command',
      command: HOOK_COMMAND,
      args: ['claude-code', event, '--wait'],
      additionalContextLimit: ADDITIONAL_CONTEXT_LIMIT,
    };
  }
  return { type: 'command', command: HOOK_COMMAND, args: ['claude-code', event] };
}

/**
 * Idempotently upserts driftlock's hook entries into `.claude/settings.json`.
 * Per event: an existing driftlock entry that already matches the desired
 * shape is left alone; one that doesn't (e.g. an install from before
 * `SessionStart` needed `--wait`) is replaced in place rather than treated
 * as already-wired-and-skipped — otherwise a repo that ran `init` before a
 * driftlock upgrade never picks up new hook behavior on re-init.
 */
export function installClaudeCodeHooks(repo: RepoRef): InstallResult {
  const path = settingsPath(repo.root);
  const settings: ClaudeSettings = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf-8')) as ClaudeSettings)
    : {};
  settings.hooks ??= {};

  let changedCount = 0;
  for (const event of HOOKED_EVENTS) {
    const desired = hookEntry(event);
    const groups = settings.hooks[event] ?? [];

    let found = false;
    let changed = false;
    for (const g of groups) {
      for (let i = 0; i < g.hooks.length; i++) {
        const h = g.hooks[i] as HookEntry;
        if (h.command !== HOOK_COMMAND) continue;
        found = true;
        if (!entryMatches(h, desired)) {
          g.hooks[i] = desired;
          changed = true;
        }
      }
    }
    if (!found) {
      groups.push({ matcher: '*', hooks: [desired] });
      changed = true;
    }
    settings.hooks[event] = groups;
    if (changed) changedCount += 1;
  }

  if (changedCount === 0) {
    return { installed: true, details: `hooks already wired in ${path}` };
  }

  mkdirSync(join(repo.root, '.claude'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return { installed: true, details: `wired/upgraded ${changedCount} hook(s) into ${path}` };
}
