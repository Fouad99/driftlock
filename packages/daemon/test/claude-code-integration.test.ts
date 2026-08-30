import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '@driftlock/adapter-claude-code';
import { openRegistryDb, openRepoDb, repoDbPath } from '@driftlock/core';
import { type DaemonHandle, startDaemon } from '../src/index.ts';

let base: string;
let repoDir: string;
let home: string;
let daemon: DaemonHandle | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'driftlock-cc-daemon-test-'));
  repoDir = join(base, 'repo');
  home = join(base, 'driftlock-home');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  daemon?.stop();
  daemon = undefined;
  rmSync(base, { recursive: true, force: true });
});

async function postHook(
  port: number,
  token: string,
  event: string,
  payload: unknown,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      agent: 'claude-code',
      event,
      cwd: repoDir,
      receivedAt: Date.now(),
      payload,
    }),
  });
}

describe('a full Claude Code hook-driven session', () => {
  test('SessionStart -> UserPromptSubmit -> PostToolUse(Edit) -> PostToolUse(Bash test) -> Stop produces a stored session with findings', async () => {
    mkdirSync(join(repoDir, '.driftlock'), { recursive: true });
    const registry = openRegistryDb(join(home, 'registry.sqlite'));
    registry.upsertRepo({
      repoId: 'repo-1',
      root: repoDir,
      name: 'repo',
      agents: ['claude-code'],
      registeredAt: Date.now(),
      lastSeen: Date.now(),
    });
    registry.close();

    daemon = await startDaemon({
      driftlockHomeDir: home,
      adapters: { 'claude-code': new ClaudeCodeAdapter() },
    });
    const { port, token } = daemon;
    const sessionId = 'claude-sess-e2e';

    let res = await postHook(port, token, 'SessionStart', {
      session_id: sessionId,
      cwd: repoDir,
      hook_event_name: 'SessionStart',
      session_reason: 'startup',
    });
    expect(res.status).toBe(200);

    res = await postHook(port, token, 'UserPromptSubmit', {
      session_id: sessionId,
      cwd: repoDir,
      hook_event_name: 'UserPromptSubmit',
      user_prompt: 'fix src/a.ts',
    });
    expect(res.status).toBe(200);

    res = await postHook(port, token, 'PostToolUse', {
      session_id: sessionId,
      cwd: repoDir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/a.ts', old_string: 'foo', new_string: 'bar' },
      tool_output: { ok: true },
    });
    expect(res.status).toBe(200);

    res = await postHook(port, token, 'PostToolUse', {
      session_id: sessionId,
      cwd: repoDir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_output: { exit_code: 0, stdout: 'all good' },
    });
    expect(res.status).toBe(200);

    res = await postHook(port, token, 'Stop', {
      session_id: sessionId,
      cwd: repoDir,
      hook_event_name: 'Stop',
      last_assistant_message: 'Done, tests pass.',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { handled: boolean };
    expect(body.handled).toBe(true);

    const repoDb = openRepoDb(repoDbPath(repoDir));
    try {
      const session = repoDb.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session?.agent).toBe('claude-code');
      expect(session?.endedAt).not.toBeNull();

      const events = repoDb.getEvents(sessionId);
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain('user_turn');
      expect(kinds).toContain('file_edit');
      expect(kinds).toContain('test_run');
      expect(kinds).toContain('agent_turn'); // from Stop's last_assistant_message

      // test_before_claim should NOT fire: a test ran after the last edit.
      const findings = repoDb.listFindings({ sessionId });
      expect(findings.some((f) => f.analyzer === 'test_before_claim')).toBe(false);
    } finally {
      repoDb.close();
    }
  });

  test('rejects hooks for a repo that was never registered', async () => {
    daemon = await startDaemon({
      driftlockHomeDir: home,
      adapters: { 'claude-code': new ClaudeCodeAdapter() },
    });
    const res = await postHook(daemon.port, daemon.token, 'SessionStart', {
      session_id: 'x',
      cwd: repoDir,
      hook_event_name: 'SessionStart',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { handled: boolean };
    expect(body.handled).toBe(false);
  });
});
