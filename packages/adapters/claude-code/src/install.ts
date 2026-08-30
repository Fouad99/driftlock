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

interface HookEntry {
  type: string;
  command: string;
  args?: string[];
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

function alreadyWired(groups: MatcherGroup[] | undefined): boolean {
  return !!groups?.some((g) => g.hooks.some((h) => h.command === HOOK_COMMAND));
}

export function installClaudeCodeHooks(repo: RepoRef): InstallResult {
  const path = settingsPath(repo.root);
  const settings: ClaudeSettings = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf-8')) as ClaudeSettings)
    : {};
  settings.hooks ??= {};

  let addedCount = 0;
  for (const event of HOOKED_EVENTS) {
    const groups = settings.hooks[event] ?? [];
    if (alreadyWired(groups)) continue;
    groups.push({
      matcher: '*',
      hooks: [{ type: 'command', command: HOOK_COMMAND, args: ['claude-code', event] }],
    });
    settings.hooks[event] = groups;
    addedCount += 1;
  }

  if (addedCount === 0) {
    return { installed: true, details: `hooks already wired in ${path}` };
  }

  mkdirSync(join(repo.root, '.claude'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return { installed: true, details: `wired ${addedCount} hook(s) into ${path}` };
}
