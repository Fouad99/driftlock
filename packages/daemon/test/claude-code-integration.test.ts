import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '@driftlock/adapter-claude-code';
import { noopLogger, openRegistryDb, openRepoDb, repoDbPath } from '@driftlock/core';
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
  id: string = crypto.randomUUID(),
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      id,
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
      logger: noopLogger,
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

  test('replaying the same SessionStart envelope id is a safe no-op, not a constraint error', async () => {
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
      logger: noopLogger,
    });
    const { port, token } = daemon;
    const sessionId = 'claude-sess-retry';
    const envelopeId = 'same-envelope-id';
    const startPayload = {
      session_id: sessionId,
      cwd: repoDir,
      hook_event_name: 'SessionStart',
      session_reason: 'startup',
    };

    // Simulates: the hook client's request timed out client-side (so it
    // spooled), but the daemon actually finished processing it live — the
    // spool drain later replays the exact same envelope id.
    const first = await postHook(port, token, 'SessionStart', startPayload, envelopeId);
    expect(first.status).toBe(200);
    const replay = await postHook(port, token, 'SessionStart', startPayload, envelopeId);
    expect(replay.status).toBe(200); // not a 500 from a duplicate-key constraint error
    const replayBody = (await replay.json()) as { handled: boolean };
    expect(replayBody.handled).toBe(true);

    const repoDb = openRepoDb(repoDbPath(repoDir));
    try {
      expect(repoDb.listSessions({ limit: 10 })).toHaveLength(1); // not duplicated
    } finally {
      repoDb.close();
    }
  });

  test('two genuinely concurrent deliveries of the same envelope id do not both apply', async () => {
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
      logger: noopLogger,
    });
    const { port, token } = daemon;
    const sessionId = 'claude-sess-concurrent';
    const envelopeId = 'concurrent-envelope-id';
    const startPayload = {
      session_id: sessionId,
      cwd: repoDir,
      hook_event_name: 'SessionStart',
      session_reason: 'startup',
    };

    // Fired together (not awaited one at a time) — this is the scenario a
    // separate check-then-mark can't protect against: both requests could
    // see "not yet applied" before either finishes applying.
    const [a, b] = await Promise.all([
      postHook(port, token, 'SessionStart', startPayload, envelopeId),
      postHook(port, token, 'SessionStart', startPayload, envelopeId),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const repoDb = openRepoDb(repoDbPath(repoDir));
    try {
      expect(repoDb.listSessions({ limit: 10 })).toHaveLength(1); // exactly one, not two
    } finally {
      repoDb.close();
    }
  });

  test('replaying the same PostToolUse envelope id does not duplicate events', async () => {
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
      logger: noopLogger,
    });
    const { port, token } = daemon;
    const sessionId = 'claude-sess-retry-2';

    await postHook(port, token, 'SessionStart', {
      session_id: sessionId,
      cwd: repoDir,
      hook_event_name: 'SessionStart',
      session_reason: 'startup',
    });

    const editEnvelopeId = 'edit-envelope-id';
    const editPayload = {
      session_id: sessionId,
      cwd: repoDir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/a.ts', old_string: 'foo', new_string: 'bar' },
      tool_output: { ok: true },
    };
    await postHook(port, token, 'PostToolUse', editPayload, editEnvelopeId);
    await postHook(port, token, 'PostToolUse', editPayload, editEnvelopeId); // replay, same id

    const repoDb = openRepoDb(repoDbPath(repoDir));
    try {
      const edits = repoDb.getEvents(sessionId).filter((e) => e.kind === 'file_edit');
      expect(edits).toHaveLength(1); // not doubled
    } finally {
      repoDb.close();
    }
  });

  test('a no-op envelope (session_start missed) is unclaimed, so a later retry can still apply', async () => {
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
      logger: noopLogger,
    });
    const { port, token } = daemon;
    const sessionId = 'claude-sess-no-session-start';
    const editEnvelopeId = 'edit-before-session-start';
    const editPayload = {
      session_id: sessionId,
      cwd: repoDir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/a.ts', old_string: 'foo', new_string: 'bar' },
      tool_output: { ok: true },
    };

    // This PostToolUse's session_start was never delivered (simulates the
    // spool-drain-vs-live-hook race: a live event's session doesn't exist
    // yet because the SessionStart is still queued elsewhere) — the daemon
    // should mark it "nothing applied", not permanently consume its id.
    const first = await postHook(port, token, 'PostToolUse', editPayload, editEnvelopeId);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { handled: boolean };
    expect(firstBody.handled).toBe(false);

    await postHook(port, token, 'SessionStart', {
      session_id: sessionId,
      cwd: repoDir,
      hook_event_name: 'SessionStart',
      session_reason: 'startup',
    });

    // Retry with the *same* envelope id, now that the session exists — if
    // the earlier no-op had left the id permanently claimed, this would be
    // treated as a duplicate and dropped instead of actually applying.
    const retry = await postHook(port, token, 'PostToolUse', editPayload, editEnvelopeId);
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { handled: boolean };
    expect(retryBody.handled).toBe(true);

    const repoDb = openRepoDb(repoDbPath(repoDir));
    try {
      const edits = repoDb.getEvents(sessionId).filter((e) => e.kind === 'file_edit');
      expect(edits).toHaveLength(1);
    } finally {
      repoDb.close();
    }
  });

  test('SessionStart returns a stored brief as additionalContext', async () => {
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

    const repoDb = openRepoDb(repoDbPath(repoDir));
    repoDb.upsertBrief({
      sessionId: 'prior-session',
      generatedAt: Date.now(),
      markdown: '# Resume brief\nfix the flaky test',
    });
    repoDb.close();

    daemon = await startDaemon({
      driftlockHomeDir: home,
      adapters: { 'claude-code': new ClaudeCodeAdapter() },
      logger: noopLogger,
    });

    const res = await postHook(daemon.port, daemon.token, 'SessionStart', {
      session_id: 'new-sess',
      cwd: repoDir,
      hook_event_name: 'SessionStart',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hookSpecificOutput?: { hookEventName: string; additionalContext: string };
    };
    expect(body.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(body.hookSpecificOutput?.additionalContext).toContain('fix the flaky test');
  });

  test('SessionStart with no stored brief yet returns no additionalContext', async () => {
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
      logger: noopLogger,
    });

    const res = await postHook(daemon.port, daemon.token, 'SessionStart', {
      session_id: 'new-sess',
      cwd: repoDir,
      hook_event_name: 'SessionStart',
    });
    const body = (await res.json()) as { hookSpecificOutput?: unknown };
    expect(body.hookSpecificOutput).toBeUndefined();
  });

  test('rejects hooks for a repo that was never registered', async () => {
    daemon = await startDaemon({
      driftlockHomeDir: home,
      adapters: { 'claude-code': new ClaudeCodeAdapter() },
      logger: noopLogger,
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
