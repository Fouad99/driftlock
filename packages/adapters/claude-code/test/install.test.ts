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

  test('is idempotent: re-running does not duplicate entries', () => {
    installClaudeCodeHooks({ root: repoRoot, repoId: 'r1' });
    installClaudeCodeHooks({ root: repoRoot, repoId: 'r1' });

    const settings = readSettings() as { hooks: Record<string, unknown[]> };
    expect(settings.hooks.SessionStart).toHaveLength(1);
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
