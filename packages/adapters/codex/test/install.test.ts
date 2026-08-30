import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexHooksFile, installCodexHooks } from '../src/install.ts';

let repoRoot: string;
let fakeBinDir: string;
let originalPath: string | undefined;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'driftlock-codex-install-test-'));
  // installCodexHooks refuses to run unless `driftlock-hook` resolves to an
  // absolute path via `Bun.which` — put a fake one on PATH so these tests
  // exercise the real resolution path instead of a build-only helper.
  fakeBinDir = mkdtempSync(join(tmpdir(), 'driftlock-codex-fakebin-'));
  const fakeBin = join(fakeBinDir, 'driftlock-hook');
  writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeBin, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ''}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(fakeBinDir, { recursive: true, force: true });
});

function readHooksFile(): { hooks: Record<string, unknown[]> } {
  return JSON.parse(readFileSync(join(repoRoot, '.codex', 'hooks.json'), 'utf-8'));
}

const EXPECTED_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'PreCompact',
  'PostCompact',
  'Stop',
  'SessionEnd',
];

describe('installCodexHooks — hook-bin resolution', () => {
  test('refuses to install (does not write hooks.json) when driftlock-hook is not on PATH', () => {
    process.env.PATH = '';
    const result = installCodexHooks({ root: repoRoot, repoId: 'r1' });
    expect(result.installed).toBe(false);
    expect(result.details).toContain('absolute');
    expect(() => readHooksFile()).toThrow();
  });
});

describe('installCodexHooks', () => {
  test('creates .codex/hooks.json with all 9 events wired', () => {
    const result = installCodexHooks({ root: repoRoot, repoId: 'r1' });
    expect(result.installed).toBe(true);
    expect(result.details).toContain('trust the 9 driftlock entries');

    const file = readHooksFile();
    for (const event of EXPECTED_EVENTS) {
      expect(file.hooks[event]).toBeDefined();
    }
    // SubagentStart/SubagentStop are optional in M1′ — not wired.
    expect(file.hooks.SubagentStart).toBeUndefined();
    expect(file.hooks.SubagentStop).toBeUndefined();
  });

  test('is idempotent: re-running does not duplicate or rewrite', () => {
    installCodexHooks({ root: repoRoot, repoId: 'r1' });
    const firstWrite = readFileSync(join(repoRoot, '.codex', 'hooks.json'), 'utf-8');

    const result = installCodexHooks({ root: repoRoot, repoId: 'r1' });
    expect(result.details).toContain('already wired');
    expect(readFileSync(join(repoRoot, '.codex', 'hooks.json'), 'utf-8')).toBe(firstWrite);
  });

  test('every entry passes --wait so the hook client prints the daemon response', () => {
    installCodexHooks({ root: repoRoot, repoId: 'r1' });
    const file = readHooksFile();
    for (const event of EXPECTED_EVENTS) {
      for (const group of file.hooks[event] as { hooks: { command: string }[] }[]) {
        for (const hook of group.hooks) {
          expect(hook.command).toContain('--wait');
        }
      }
    }
  });
});

describe('installCodexHooks — merging and repair', () => {
  test('preserves unrelated hooks already in the file instead of overwriting the whole thing', () => {
    mkdirSync(join(repoRoot, '.codex'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.codex', 'hooks.json'),
      JSON.stringify({
        description: 'some other tool',
        hooks: {
          PostToolUse: [{ hooks: [{ type: 'command', command: 'some-other-hook', timeout: 3 }] }],
        },
      }),
    );

    installCodexHooks({ root: repoRoot, repoId: 'r1' });

    const file = readHooksFile() as {
      hooks: { PostToolUse: { hooks: { command: string }[] }[] };
    };
    const commands = file.hooks.PostToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain('some-other-hook');
    expect(commands.some((c) => c.includes('driftlock-hook'))).toBe(true);
  });

  test('repairs a partial/stale install instead of treating any one entry as fully wired', () => {
    installCodexHooks({ root: repoRoot, repoId: 'r1' });
    const full = readHooksFile() as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const sessionStartCommand = full.hooks.SessionStart[0]?.hooks[0]?.command as string;

    // Simulate a corrupted/hand-edited file: only SessionStart survived.
    writeFileSync(
      join(repoRoot, '.codex', 'hooks.json'),
      JSON.stringify({
        description: 'driftlock session observability hooks',
        hooks: { SessionStart: [{ hooks: [{ command: sessionStartCommand, timeout: 5 }] }] },
      }),
    );

    const result = installCodexHooks({ root: repoRoot, repoId: 'r1' });
    expect(result.details).toContain('wired/upgraded');

    const repaired = readHooksFile();
    for (const event of EXPECTED_EVENTS) {
      expect(repaired.hooks[event]).toBeDefined();
    }
  });

  test('a stale driftlock entry (matching command, different config) is replaced in place, not duplicated', () => {
    installCodexHooks({ root: repoRoot, repoId: 'r1' });
    const written = readHooksFile() as {
      hooks: { SessionStart: { matcher?: string; hooks: { command: string }[] }[] };
    };
    const command = written.hooks.SessionStart[0]?.hooks[0]?.command as string;

    // Same driftlock command, but a stale config (e.g. an older, shorter timeout).
    writeFileSync(
      join(repoRoot, '.codex', 'hooks.json'),
      JSON.stringify({
        description: 'driftlock session observability hooks',
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume|clear|compact',
              hooks: [{ type: 'command', command, timeout: 1 }],
            },
          ],
        },
      }),
    );

    const result = installCodexHooks({ root: repoRoot, repoId: 'r1' });
    expect(result.details).toContain('wired/upgraded');

    const repaired = readHooksFile() as {
      hooks: { SessionStart: { hooks: { command: string; timeout: number }[] }[] };
    };
    // still exactly one hook entry for SessionStart's one group — replaced, not appended
    expect(repaired.hooks.SessionStart[0]?.hooks).toHaveLength(1);
    expect(repaired.hooks.SessionStart[0]?.hooks[0]?.timeout).toBe(5);
  });
});

describe('buildCodexHooksFile', () => {
  test('PreToolUse is not async — it must be able to answer', () => {
    const file = buildCodexHooksFile('/usr/local/bin/driftlock-hook');
    const preToolUse = file.hooks.PreToolUse?.[0]?.hooks[0];
    expect(preToolUse?.async).toBeUndefined();
  });

  test('PostToolUse/PreCompact/PostCompact are async so they never slow the agent', () => {
    const file = buildCodexHooksFile('/usr/local/bin/driftlock-hook');
    for (const event of ['PostToolUse', 'PreCompact', 'PostCompact']) {
      const h = file.hooks[event]?.[0]?.hooks[0];
      expect(h?.async).toBe(true);
    }
  });

  test('SessionEnd has an explicit timeout of at most 3s', () => {
    const file = buildCodexHooksFile('/usr/local/bin/driftlock-hook');
    const sessionEnd = file.hooks.SessionEnd?.[0]?.hooks[0];
    expect(sessionEnd?.timeout).toBeLessThanOrEqual(3);
  });

  test('PreToolUse/PostToolUse matchers use Codex tool names, not Claude Code ones', () => {
    const file = buildCodexHooksFile('/usr/local/bin/driftlock-hook');
    expect(file.hooks.PreToolUse?.[0]?.matcher).toBe('apply_patch');
    expect(file.hooks.PostToolUse?.[0]?.matcher).toBe('apply_patch|Bash|update_plan');
    // regression guard against the Claude Code tool names this was
    // copy-pasted from, which never match anything Codex actually calls
    expect(file.hooks.PreToolUse?.[0]?.matcher).not.toMatch(/\bEdit\b|\bWrite\b/);
  });
});
