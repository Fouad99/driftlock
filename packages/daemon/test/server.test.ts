import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RegistryStore, openRegistryDb } from '@driftlock/core';
import { createServer } from '../src/server.ts';

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let registryDb: RegistryStore;
let home: string;
const token = 'test-token';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'driftlock-server-test-'));
  registryDb = openRegistryDb(join(home, 'registry.sqlite'));
  server = createServer({
    port: 0,
    token,
    version: '0.0.0-test',
    adapters: {},
    registryDb,
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  registryDb.close();
  rmSync(home, { recursive: true, force: true });
});

describe('GET /health', () => {
  test('responds without auth', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('0.0.0-test');
  });
});

describe('POST /hook', () => {
  const envelope = {
    id: 'test-envelope-1',
    agent: 'codex',
    event: 'test',
    cwd: '/repo',
    receivedAt: Date.now(),
    payload: {},
  };

  test('rejects a request with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/hook`, {
      method: 'POST',
      body: JSON.stringify(envelope),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  test('rejects a request with the wrong token', async () => {
    const res = await fetch(`${baseUrl}/hook`, {
      method: 'POST',
      body: JSON.stringify(envelope),
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  test('accepts a valid envelope with the right token, unhandled (no adapter registered)', async () => {
    const res = await fetch(`${baseUrl}/hook`, {
      method: 'POST',
      body: JSON.stringify(envelope),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; handled: boolean };
    expect(body.ok).toBe(true);
    expect(body.handled).toBe(false);
  });

  test('rejects a malformed envelope', async () => {
    const res = await fetch(`${baseUrl}/hook`, {
      method: 'POST',
      body: JSON.stringify({ not: 'an envelope' }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  test('rejects invalid JSON', async () => {
    const res = await fetch(`${baseUrl}/hook`, {
      method: 'POST',
      body: 'not json',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });
});

describe('unknown routes', () => {
  test('an unauthenticated GET to an unknown path 401s — it falls through to the UI static-asset gate, not a bare 404', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(401);
  });

  test('an authenticated GET to an unknown, non-/api path either serves the SPA shell or reports the UI as unbuilt — never a bare 404', async () => {
    const res = await fetch(`${baseUrl}/nope`, { headers: { authorization: `Bearer ${token}` } });
    expect([200, 503]).toContain(res.status);
  });

  test('an unmatched GET under /api/* is a real 404, not the SPA shell', async () => {
    const res = await fetch(`${baseUrl}/api/does-not-exist`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('UI static asset serving', () => {
  test('serves the built app shell for / and for a client-side route, once packages/ui is built', async () => {
    const uiDistDir = mkdtempSync(join(tmpdir(), 'driftlock-server-ui-dist-'));
    writeFileSync(join(uiDistDir, 'index.html'), '<html>the app shell</html>');
    const uiServer = createServer({
      port: 0,
      token,
      version: '0.0.0-test',
      adapters: {},
      registryDb,
      uiDistDir,
    });
    try {
      const uiBaseUrl = `http://127.0.0.1:${uiServer.port}`;
      const root = await fetch(`${uiBaseUrl}/`, { headers: { authorization: `Bearer ${token}` } });
      expect(root.status).toBe(200);
      expect(await root.text()).toBe('<html>the app shell</html>');

      const clientRoute = await fetch(`${uiBaseUrl}/repo/x/session/y`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(await clientRoute.text()).toBe('<html>the app shell</html>');
    } finally {
      uiServer.stop(true);
      rmSync(uiDistDir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/bootstrap', () => {
  test('rejects a request with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/bootstrap`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  test('rejects the wrong token', async () => {
    const res = await fetch(`${baseUrl}/api/bootstrap`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  test('returns a nonce for the right token', async () => {
    const res = await fetch(`${baseUrl}/api/bootstrap`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nonce: string };
    expect(body.nonce).toBeTruthy();
  });
});

describe('GET /?bootstrap=<nonce>', () => {
  async function mintNonce(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/bootstrap`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    return ((await res.json()) as { nonce: string }).nonce;
  }

  test('a valid nonce redirects to / and sets the session cookie', async () => {
    const nonce = await mintNonce();
    const res = await fetch(`${baseUrl}/?bootstrap=${nonce}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('driftlock_session=');
    expect(cookie).toContain('HttpOnly');
  });

  test('the same nonce cannot be consumed twice', async () => {
    const nonce = await mintNonce();
    await fetch(`${baseUrl}/?bootstrap=${nonce}`, { redirect: 'manual' });
    const second = await fetch(`${baseUrl}/?bootstrap=${nonce}`, { redirect: 'manual' });
    expect(second.status).toBe(401);
  });

  test('an unknown nonce is rejected', async () => {
    const res = await fetch(`${baseUrl}/?bootstrap=not-a-real-nonce`, { redirect: 'manual' });
    expect(res.status).toBe(401);
  });
});

describe('/api/* auth and origin gating', () => {
  test('GET /api/* with no auth is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/repos`);
    expect(res.status).toBe(401);
  });

  test('GET /api/* with the bearer token passes auth and reaches the real route', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: unknown[] };
    expect(body.repos).toEqual([]);
  });

  test('GET /api/* with a valid session cookie passes auth', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, {
      headers: { cookie: `driftlock_session=${token}` },
    });
    expect(res.status).toBe(200);
  });

  test('a mutation (non-GET) with the bearer token but no matching Host/Origin is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/repos/x/findings/y/resolve`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        host: 'evil.example',
        origin: 'http://evil.example',
      },
    });
    expect(res.status).toBe(403);
  });

  test('a mutation with the bearer token and a matching Host passes the origin check (404s for real — repo "x" is not registered)', async () => {
    const res = await fetch(`${baseUrl}/api/repos/x/findings/y/resolve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});
