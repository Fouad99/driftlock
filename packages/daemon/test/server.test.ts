import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
  test('404s', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});
