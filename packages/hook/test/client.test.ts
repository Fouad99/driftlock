import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHookClient } from '../src/client.ts';
import { spoolPath } from '../src/spool.ts';

let home: string;
let fakeDaemon: ReturnType<typeof Bun.serve> | undefined;
const TOKEN = 'test-token';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'driftlock-hook-client-test-'));
});

afterEach(() => {
  fakeDaemon?.stop(true);
  fakeDaemon = undefined;
  rmSync(home, { recursive: true, force: true });
});

function writeDaemonJson(port: number, token = TOKEN): void {
  writeFileSync(
    join(home, 'daemon.json'),
    JSON.stringify({ port, token, pid: 1, version: '0.0.0', startedAt: Date.now() }),
  );
}

describe('runHookClient', () => {
  test('spools when there is no daemon.json', async () => {
    const result = await runHookClient({
      agent: 'codex',
      event: 'notify',
      cwd: '/repo',
      driftlockHomeDir: home,
      stdinText: '{}',
    });
    expect(result.delivered).toBe(false);
    expect(existsSync(spoolPath(home, 'codex'))).toBe(true);
  });

  test('spools when the daemon is unreachable (stale port)', async () => {
    // Bind briefly to get a real ephemeral port, then close it — guarantees
    // nothing is listening there, unlike guessing a fixed high port number.
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    const stalePort = probe.port;
    probe.stop(true);

    writeDaemonJson(stalePort);
    const result = await runHookClient({
      agent: 'codex',
      event: 'notify',
      cwd: '/repo',
      driftlockHomeDir: home,
      stdinText: '{}',
      timeoutMs: 200,
    });
    expect(result.delivered).toBe(false);
    expect(existsSync(spoolPath(home, 'codex'))).toBe(true);
  });

  test('delivers to a live daemon with the right auth header and does not spool', async () => {
    let receivedAuth: string | null = null;
    let receivedBody: unknown;
    fakeDaemon = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        receivedAuth = req.headers.get('authorization');
        receivedBody = await req.json();
        return Response.json({ ok: true, handled: false });
      },
    });
    writeDaemonJson(fakeDaemon.port);

    const result = await runHookClient({
      agent: 'codex',
      event: 'notify',
      cwd: '/repo',
      driftlockHomeDir: home,
      stdinText: '{"hello":"world"}',
    });

    expect(result.delivered).toBe(true);
    expect(result.responseBody).toEqual({ ok: true, handled: false });
    expect(receivedAuth).toBe(`Bearer ${TOKEN}`);
    expect(receivedBody).toMatchObject({
      agent: 'codex',
      event: 'notify',
      payload: { hello: 'world' },
    });
    expect(existsSync(spoolPath(home, 'codex'))).toBe(false);
  });

  test('spools when the daemon responds with a non-2xx status', async () => {
    fakeDaemon = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        return Response.json({ ok: false }, { status: 401 });
      },
    });
    writeDaemonJson(fakeDaemon.port);

    const result = await runHookClient({
      agent: 'codex',
      event: 'notify',
      cwd: '/repo',
      driftlockHomeDir: home,
      stdinText: '{}',
    });
    expect(result.delivered).toBe(false);
    expect(existsSync(spoolPath(home, 'codex'))).toBe(true);
  });

  test('spools when the daemon does not respond within the timeout', async () => {
    fakeDaemon = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch() {
        await new Promise((r) => setTimeout(r, 500));
        return Response.json({ ok: true, handled: false });
      },
    });
    writeDaemonJson(fakeDaemon.port);

    const result = await runHookClient({
      agent: 'codex',
      event: 'notify',
      cwd: '/repo',
      driftlockHomeDir: home,
      stdinText: '{}',
      timeoutMs: 50,
    });
    expect(result.delivered).toBe(false);
    expect(existsSync(spoolPath(home, 'codex'))).toBe(true);
  });

  test('appends to the spool file for the correct agent when spooling', async () => {
    await runHookClient({
      agent: 'claude-code',
      event: 'SessionStart',
      cwd: '/repo',
      driftlockHomeDir: home,
      stdinText: '{}',
    });
    expect(existsSync(spoolPath(home, 'claude-code'))).toBe(true);
    const line = readFileSync(spoolPath(home, 'claude-code'), 'utf-8').trim();
    expect(JSON.parse(line)).toMatchObject({ agent: 'claude-code', event: 'SessionStart' });
  });
});
