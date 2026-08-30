import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstallResult, RepoRef } from '@driftlock/core';

// M1′ §B2/B3 — `.codex/hooks.json`, written instead of the M1 transcript-first
// wiring. `<hook-bin>` must be an absolute path (Codex may be launched from a
// subdirectory) — resolved via `Bun.which`, not hardcoded like Claude Code's
// bare `driftlock-hook` (which relies on Claude Code always resolving via
// PATH from the repo root). `--wait` is passed on every entry so the hook
// client prints the daemon's JSON response to stdout — Codex requires JSON
// output on `Stop`/`SessionEnd` (§B5), and every entry emits `{}` at minimum
// once M1′'s `onHook` outputs are all `{}`-shaped anyway.
//
// `SubagentStart`/`SubagentStop` are deliberately not wired — optional in
// M1′ per §B4's closing note.

const HOOK_BIN_NAME = 'driftlock-hook';
const TRUST_ENTRY_COUNT = 9;

interface HookEntry {
  type: string;
  command: string;
  commandWindows: string;
  timeout: number;
  async?: boolean;
  additionalContextLimit?: number;
  statusMessage?: string;
}
interface MatcherGroup {
  matcher?: string;
  hooks: HookEntry[];
}
interface CodexHooksFile {
  description: string;
  hooks: Record<string, MatcherGroup[]>;
}

/**
 * `null` if `driftlock-hook` can't be resolved to an absolute path — callers
 * must not fall back to the bare command, since Codex requires an absolute
 * `<hook-bin>` (it may launch from a subdirectory). Passes `PATH` explicitly
 * rather than relying on `Bun.which`'s implicit lookup, which snapshots
 * `process.env.PATH` at process start and won't see a later change to it —
 * relevant to anything that sets `PATH` and calls `runInit` in the same
 * process (tests included), not just a real shell invocation.
 */
function resolveHookBin(): string | null {
  return Bun.which(HOOK_BIN_NAME, { PATH: process.env.PATH ?? '' });
}

function hooksPath(repoRoot: string): string {
  return join(repoRoot, '.codex', 'hooks.json');
}

function entry(
  hookBin: string,
  event: string,
  opts: {
    timeout: number;
    async?: boolean;
    additionalContextLimit?: number;
    statusMessage?: string;
  },
): HookEntry {
  const command = `${hookBin} codex ${event} --wait`;
  return {
    type: 'command',
    command,
    commandWindows: command,
    timeout: opts.timeout,
    ...(opts.async !== undefined ? { async: opts.async } : {}),
    ...(opts.additionalContextLimit !== undefined
      ? { additionalContextLimit: opts.additionalContextLimit }
      : {}),
    ...(opts.statusMessage !== undefined ? { statusMessage: opts.statusMessage } : {}),
  };
}

/** The `.codex/hooks.json` contents `init` writes — exported for tests. */
export function buildCodexHooksFile(hookBin: string): CodexHooksFile {
  return {
    description: 'driftlock session observability hooks',
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|resume|clear|compact',
          hooks: [
            entry(hookBin, 'SessionStart', {
              timeout: 5,
              additionalContextLimit: 2000,
              statusMessage: 'driftlock: loading session brief',
            }),
          ],
        },
      ],
      UserPromptSubmit: [{ hooks: [entry(hookBin, 'UserPromptSubmit', { timeout: 3 })] }],
      // Matchers are Codex's own tool names — verified against
      // codex-rs/core/src/tools/hook_names.rs's `HookToolName` canonical
      // names, not just the docs' matcher-alias table (which lists `Edit`/
      // `Write` as extra matcher aliases for `apply_patch`, and would have
      // led here to the wrong name for shell entirely: the docs only show
      // "Match as Bash", but don't say outright that the hook payload's
      // `tool_name` really is the literal string "Bash" — hook_names.rs's
      // `HookToolName::bash()` does, with no aliases). Earlier versions of
      // this file used Claude Code's tool names (`Edit|Write`,
      // `Bash|Edit|Write` as a literal copy, not Codex's own `Bash`) by
      // mistake, then briefly `shell` (confused with the transcript
      // format's unrelated function name) — neither ever matched anything
      // Codex actually calls.
      PreToolUse: [
        {
          matcher: 'apply_patch',
          hooks: [
            entry(hookBin, 'PreToolUse', {
              timeout: 3,
              statusMessage: 'driftlock: checking decisions',
            }),
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'apply_patch|Bash|update_plan',
          hooks: [entry(hookBin, 'PostToolUse', { timeout: 3, async: true })],
        },
      ],
      PermissionRequest: [{ hooks: [entry(hookBin, 'PermissionRequest', { timeout: 2 })] }],
      PreCompact: [{ hooks: [entry(hookBin, 'PreCompact', { timeout: 2, async: true })] }],
      PostCompact: [{ hooks: [entry(hookBin, 'PostCompact', { timeout: 2, async: true })] }],
      Stop: [{ hooks: [entry(hookBin, 'Stop', { timeout: 3 })] }],
      SessionEnd: [{ hooks: [entry(hookBin, 'SessionEnd', { timeout: 3 })] }],
    },
  };
}

/** Same driftlock entry, same effective config — nothing to rewrite. */
function entryMatches(existing: HookEntry, desired: HookEntry): boolean {
  return (
    existing.command === desired.command &&
    existing.timeout === desired.timeout &&
    (existing.async ?? false) === (desired.async ?? false) &&
    (existing.additionalContextLimit ?? null) === (desired.additionalContextLimit ?? null) &&
    (existing.statusMessage ?? null) === (desired.statusMessage ?? null)
  );
}

function trustMessage(path: string): string {
  return [
    `Codex hooks written to ${path}.`,
    'Codex will not run them until you trust them:',
    '  1. open Codex in this repo',
    '  2. run /hooks',
    `  3. trust the ${TRUST_ENTRY_COUNT} driftlock entries`,
    'Until then, Codex sessions are captured from transcripts after they end.',
  ].join('\n');
}

/**
 * Merges driftlock's 9 entries into `.codex/hooks.json` — never a wholesale
 * overwrite, so hooks a user configured for something else survive. Per
 * event: an existing driftlock entry (`command` starting with `hookBin`) that
 * already matches is left alone; one that doesn't (a stale install, or
 * `hookBin` itself moved) is replaced in place; no existing driftlock entry
 * means one is appended alongside whatever else is already in that event's
 * groups. "Already wired" is only reported when all 9 events need no change
 * — a partial or stale install (e.g. a hand-edited or corrupted file with
 * only some entries present) is repaired rather than silently left as-is.
 */
export function installCodexHooks(repo: RepoRef): InstallResult {
  const hookBin = resolveHookBin();
  if (!hookBin) {
    return {
      installed: false,
      details: `could not resolve an absolute path to \`${HOOK_BIN_NAME}\` — Codex requires an absolute \`<hook-bin>\` path (it may launch from a subdirectory), so nothing was written. Install \`${HOOK_BIN_NAME}\` so it's on PATH, then re-run \`driftlock init\`.`,
    };
  }

  const path = hooksPath(repo.root);
  const desired = buildCodexHooksFile(hookBin);

  let existing: CodexHooksFile | null = null;
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf-8')) as CodexHooksFile;
    } catch {
      existing = null; // unparseable — treat as absent
    }
  }

  const merged: CodexHooksFile = {
    description: existing?.description ?? desired.description,
    hooks: { ...(existing?.hooks ?? {}) },
  };

  let changedCount = 0;
  for (const [event, desiredGroups] of Object.entries(desired.hooks)) {
    const desiredEntry = (desiredGroups[0] as MatcherGroup).hooks[0] as HookEntry;
    const existingGroups = merged.hooks[event] ?? [];

    let found = false;
    let changed = false;
    const nextGroups = existingGroups.map((g) => ({
      ...g,
      hooks: g.hooks.map((h) => {
        if (!h.command.startsWith(hookBin)) return h; // foreign entry — leave untouched
        found = true;
        if (!entryMatches(h, desiredEntry)) changed = true;
        return desiredEntry;
      }),
    }));
    if (!found) {
      nextGroups.push(desiredGroups[0] as MatcherGroup);
      changed = true;
    }
    merged.hooks[event] = nextGroups;
    if (changed) changedCount += 1;
  }

  if (changedCount === 0) {
    return { installed: true, details: `hooks already wired in ${path}` };
  }

  mkdirSync(join(repo.root, '.codex'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);

  return {
    installed: true,
    details: `wired/upgraded ${changedCount} hook(s) into ${path}\n\n${trustMessage(path)}`,
  };
}
