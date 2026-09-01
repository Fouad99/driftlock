import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type RegistryStore,
  type RepoStore,
  openRegistryDb,
  openRepoDb,
  repoDbPath,
} from '@driftlock/core';
import { createServer } from '../src/server.ts';

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let registryDb: RegistryStore;
let repoDb: RepoStore;
let home: string;
let repoRoot: string;
const token = 'test-token';
const authHeaders = { authorization: `Bearer ${token}` };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'driftlock-routes-test-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'driftlock-routes-repo-'));
  mkdirSync(join(repoRoot, '.driftlock'), { recursive: true });
  registryDb = openRegistryDb(join(home, 'registry.sqlite'));
  repoDb = openRepoDb(repoDbPath(repoRoot));
  registryDb.upsertRepo({
    repoId: 'repo-1',
    root: repoRoot,
    name: 'repo',
    agents: ['claude-code'],
    registeredAt: 1000,
    lastSeen: 1000,
  });
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
  repoDb.close();
  registryDb.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

function seedSession(): string {
  const session = repoDb.createSession({
    agent: 'claude-code',
    agentSession: null,
    repoRoot,
    branch: null,
    headBefore: null,
    headAfter: null,
    startedAt: 1000,
    taskText: null,
    tokenIn: null,
    tokenOut: null,
    costUsd: null,
    source: 'hooks',
  });
  return session.id;
}

describe('GET /api/repos/:id', () => {
  test('returns 404 for an unregistered repo', async () => {
    const res = await fetch(`${baseUrl}/api/repos/no-such-repo`, { headers: authHeaders });
    expect(res.status).toBe(404);
  });

  test('returns the repo, its sessions, and the latest brief', async () => {
    seedSession();
    repoDb.upsertBrief({ sessionId: 'x', generatedAt: 1, markdown: '# brief' });
    const res = await fetch(`${baseUrl}/api/repos/repo-1`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repo: { repoId: string };
      sessions: unknown[];
      brief: unknown;
    };
    expect(body.repo.repoId).toBe('repo-1');
    expect(body.sessions).toHaveLength(1);
    expect(body.brief).not.toBeNull();
  });
});

describe('GET /api/repos/:id/sessions/:sid', () => {
  test('returns 404 for an unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/repos/repo-1/sessions/no-such-session`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
  });

  test('returns session detail with findings', async () => {
    const sessionId = seedSession();
    repoDb.createFinding({
      sessionId,
      analyzer: 'loop',
      severity: 'warn',
      title: 'x',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });
    const res = await fetch(`${baseUrl}/api/repos/repo-1/sessions/${sessionId}`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { findings: unknown[] };
    expect(body.findings).toHaveLength(1);
  });
});

describe('GET /api/repos/:id/sessions/:sid/events', () => {
  test('returns a bounded page of summaries', async () => {
    const sessionId = seedSession();
    repoDb.appendEvents(
      sessionId,
      Array.from({ length: 3 }, (_, i) => ({
        sessionId,
        ts: 1000 + i,
        kind: 'user_turn' as const,
        payload: { text: `turn ${i}` },
      })),
    );
    const res = await fetch(`${baseUrl}/api/repos/repo-1/sessions/${sessionId}/events?limit=2`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; nextFrom: number | null };
    expect(body.events).toHaveLength(2);
    expect(body.nextFrom).toBe(2);
  });

  test('/events/:seq returns the full event payload', async () => {
    const sessionId = seedSession();
    repoDb.appendEvents(sessionId, [
      { sessionId, ts: 1000, kind: 'user_turn', payload: { text: 'hello' } },
    ]);
    const res = await fetch(`${baseUrl}/api/repos/repo-1/sessions/${sessionId}/events/0`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payload: { text: string } };
    expect(body.payload.text).toBe('hello');
  });

  test('/events/:seq 404s for a seq that does not exist', async () => {
    const sessionId = seedSession();
    const res = await fetch(`${baseUrl}/api/repos/repo-1/sessions/${sessionId}/events/99`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/repos/:id/sessions/:sid/evidence', () => {
  test('requires findingId', async () => {
    const sessionId = seedSession();
    const res = await fetch(`${baseUrl}/api/repos/repo-1/sessions/${sessionId}/evidence`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(400);
  });

  test('returns the padded evidence window for a finding', async () => {
    const sessionId = seedSession();
    repoDb.appendEvents(
      sessionId,
      Array.from({ length: 5 }, (_, i) => ({
        sessionId,
        ts: 1000 + i,
        kind: 'user_turn' as const,
        payload: { text: `turn ${i}` },
      })),
    );
    const finding = repoDb.createFinding({
      sessionId,
      analyzer: 'loop',
      severity: 'warn',
      title: 'x',
      explanation: 'x',
      fromSeq: 2,
      toSeq: 2,
      data: null,
    });
    const res = await fetch(
      `${baseUrl}/api/repos/repo-1/sessions/${sessionId}/evidence?findingId=${finding.id}`,
      { headers: authHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { seq: number }[] };
    expect(body.events.map((e) => e.seq)).toContain(2);
  });
});

describe('GET /api/repos/:id/commits/:sha', () => {
  test('404s for a sha that does not resolve', async () => {
    const res = await fetch(`${baseUrl}/api/repos/repo-1/commits/deadbeef`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/repos/:id/findings/:fid/resolve', () => {
  test('404s for an unknown finding', async () => {
    const res = await fetch(`${baseUrl}/api/repos/repo-1/findings/no-such/resolve`, {
      method: 'POST',
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
  });

  test('resolves the finding', async () => {
    const sessionId = seedSession();
    const finding = repoDb.createFinding({
      sessionId,
      analyzer: 'loop',
      severity: 'warn',
      title: 'x',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });
    const res = await fetch(`${baseUrl}/api/repos/repo-1/findings/${finding.id}/resolve`, {
      method: 'POST',
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolvedAt: number | null };
    expect(body.resolvedAt).not.toBeNull();
  });
});

describe('POST/DELETE /api/repos/:id/findings/:fid/brief', () => {
  test('POST pins, DELETE unpins', async () => {
    const sessionId = seedSession();
    repoDb.endSession(sessionId, 2000, 'stop');
    const finding = repoDb.createFinding({
      sessionId,
      analyzer: 'loop',
      severity: 'warn',
      title: 'x',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });

    const pinRes = await fetch(`${baseUrl}/api/repos/repo-1/findings/${finding.id}/brief`, {
      method: 'POST',
      headers: authHeaders,
    });
    expect(pinRes.status).toBe(200);
    expect(((await pinRes.json()) as { pinned: boolean }).pinned).toBe(true);

    const unpinRes = await fetch(`${baseUrl}/api/repos/repo-1/findings/${finding.id}/brief`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(unpinRes.status).toBe(200);
    expect(((await unpinRes.json()) as { pinned: boolean }).pinned).toBe(false);
  });
});

describe('GET /api/events (SSE)', () => {
  test('delivers a repo_updated event published after a mutation', async () => {
    const sessionId = seedSession();
    const finding = repoDb.createFinding({
      sessionId,
      analyzer: 'loop',
      severity: 'warn',
      title: 'x',
      explanation: 'x',
      fromSeq: null,
      toSeq: null,
      data: null,
    });

    const sseRes = await fetch(`${baseUrl}/api/events`, { headers: authHeaders });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
    const reader = (sseRes.body as ReadableStream<Uint8Array>).getReader();

    // Give the subscription a moment to attach before triggering the mutation.
    await new Promise((r) => setTimeout(r, 20));
    await fetch(`${baseUrl}/api/repos/repo-1/findings/${finding.id}/resolve`, {
      method: 'POST',
      headers: authHeaders,
    });

    const decoder = new TextDecoder();
    let received = '';
    const deadline = Date.now() + 2000;
    while (!received.includes('repo_updated') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }
    await reader.cancel();
    expect(received).toContain('repo_updated');
    expect(received).toContain('session_updated');
  });
});
