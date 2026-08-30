import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '@driftlock/adapter-codex';
import { noopLogger, openRegistryDb, openRepoDb, repoDbPath } from '@driftlock/core';
import { type DaemonHandle, startDaemon } from '../src/index.ts';

// Regression test for the P1 finding that Codex's SessionStart never
// requested a resume brief despite `resumeInject: true` — see adapter.ts's
// `formatResumeBrief` and the `request` output added to the `SessionStart`
// case.

let base: string;
let repoDir: string;
let home: string;
let daemon: DaemonHandle | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'driftlock-codex-injection-test-'));
  repoDir = join(base, 'repo');
  home = join(base, 'driftlock-home');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repoDir, '.driftlock'), { recursive: true });
});

afterEach(() => {
  daemon?.stop();
  daemon = undefined;
  rmSync(base, { recursive: true, force: true });
});

async function postHook(port: number, token: string, event: string, payload: unknown) {
  return fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      agent: 'codex',
      event,
      cwd: repoDir,
      receivedAt: Date.now(),
      payload,
    }),
  });
}

describe('Codex SessionStart resume brief injection', () => {
  test('returns a stored brief as additionalContext', async () => {
    const registry = openRegistryDb(join(home, 'registry.sqlite'));
    registry.upsertRepo({
      repoId: 'repo-1',
      root: repoDir,
      name: 'repo',
      agents: ['codex'],
      registeredAt: Date.now(),
      lastSeen: Date.now(),
    });
    registry.close();

    const repoDb = openRepoDb(repoDbPath(repoDir));
    repoDb.upsertBrief({
      sessionId: 'prior-session',
      generatedAt: Date.now(),
      markdown: '# Resume brief\npick up the rate limiter work',
    });
    repoDb.close();

    daemon = await startDaemon({
      driftlockHomeDir: home,
      adapters: { codex: new CodexAdapter() },
      logger: noopLogger,
    });

    const res = await postHook(daemon.port, daemon.token, 'SessionStart', {
      session_id: 'codex-sess-1',
      cwd: repoDir,
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hookSpecificOutput?: { hookEventName: string; additionalContext: string };
    };
    expect(body.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(body.hookSpecificOutput?.additionalContext).toContain('pick up the rate limiter work');
  });

  test('returns no additionalContext when there is no stored brief yet', async () => {
    const registry = openRegistryDb(join(home, 'registry.sqlite'));
    registry.upsertRepo({
      repoId: 'repo-1',
      root: repoDir,
      name: 'repo',
      agents: ['codex'],
      registeredAt: Date.now(),
      lastSeen: Date.now(),
    });
    registry.close();

    daemon = await startDaemon({
      driftlockHomeDir: home,
      adapters: { codex: new CodexAdapter() },
      logger: noopLogger,
    });

    const res = await postHook(daemon.port, daemon.token, 'SessionStart', {
      session_id: 'codex-sess-1',
      cwd: repoDir,
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    const body = (await res.json()) as { hookSpecificOutput?: unknown };
    expect(body.hookSpecificOutput).toBeUndefined();
  });
});
