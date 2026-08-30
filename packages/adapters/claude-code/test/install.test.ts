import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installClaudeCodeHooks } from '../src/install.ts';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'driftlock-claude-install-test-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf-8'));
}

describe('installClaudeCodeHooks', () => {
  test('creates .claude/settings.json with all five hooks wired', () => {
    const result = installClaudeCodeHooks({ root: repoRoot, repoId: 'r1' });
    expect(result.installed).toBe(true);

    const settings = readSettings() as { hooks: Record<string, unknown[]> };
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'Stop']) {
      expect(settings.hooks[event]).toBeDefined();
      expect(settings.hooks[event]).toHaveLength(1);
    }
    // PreToolUse (drift blocking) is M6 — must not be wired yet.
    expect(settings.hooks.PreToolUse).toBeUndefined();
  });

  test('SessionStart is wired with --wait and additionalContextLimit; other events are not', () => {
    installClaudeCodeHooks({ root: repoRoot, repoId: 'r1' });

    const settings = readSettings() as {
      hooks: Record<string, { hooks: { args?: string[]; additionalContextLimit?: number }[] }[]>;
    };
    const sessionStart = settings.hooks.SessionStart?.[0]?.hooks[0];
    expect(sessionStart?.args).toEqual(['claude-code', 'SessionStart', '--wait']);
    expect(sessionStart?.additionalContextLimit).toBe(2000);

    const stop = settings.hooks.Stop?.[0]?.hooks[0];
    expect(stop?.args).toEqual(['claude-code', 'Stop']);
    expect(stop?.additionalContextLimit).toBeUndefined();
  });

  test('is idempotent: re-running does not duplicate entries', () => {
    installClaudeCodeHooks({ root: repoRoot, repoId: 'r1' });
    installClaudeCodeHooks({ root: repoRoot, repoId: 'r1' });

    const settings = readSettings() as { hooks: Record<string, unknown[]> };
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  test('upgrades a pre-existing SessionStart entry that predates --wait, instead of skipping it', () => {
    mkdirSync(join(repoRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: '*',
              // pre-injection install: no --wait, no additionalContextLimit
              hooks: [
                {
                  type: 'command',
                  command: 'driftlock-hook',
                  args: ['claude-code', 'SessionStart'],
                },
              ],
            },
          ],
        },
      }),
    );

    const result = installClaudeCodeHooks({ root: repoRoot, repoId: 'r1' });
    expect(result.details).toContain('upgraded');

    const settings = readSettings() as {
      hooks: { SessionStart: { hooks: { args?: string[]; additionalContextLimit?: number }[] }[] };
    };
    const entry = settings.hooks.SessionStart[0]?.hooks[0];
    expect(entry?.args).toEqual(['claude-code', 'SessionStart', '--wait']);
    expect(entry?.additionalContextLimit).toBe(2000);
    // upgraded in place, not duplicated
    expect(settings.hooks.SessionStart[0]?.hooks).toHaveLength(1);
  });

  test('a second run after an upgrade reports nothing changed', () => {
    mkdirSync(join(repoRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: 'driftlock-hook',
                  args: ['claude-code', 'SessionStart'],
                },
              ],
            },
          ],
        },
      }),
    );
    installClaudeCodeHooks({ root: repoRoot, repoId: 'r1' }); // upgrades SessionStart, adds the rest
    const result = installClaudeCodeHooks({ root: repoRoot, repoId: 'r1' });
    expect(result.details).toContain('already wired');
  });

  test('preserves unrelated existing settings and hooks', () => {
    mkdirSync(join(repoRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'some-model',
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'some-other-tool' }] },
          ],
        },
      }),
    );

    installClaudeCodeHooks({ root: repoRoot, repoId: 'r1' });

    const settings = readSettings() as { model: string; hooks: Record<string, unknown[]> };
    expect(settings.model).toBe('some-model');
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });
});
