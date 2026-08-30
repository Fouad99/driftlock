import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRegistryDb, openRepoDb, repoDbPath } from '@driftlock/core';
import { readDaemonJson } from '../src/daemon-json.ts';
import { type DaemonHandle, startDaemon } from '../src/index.ts';

let base: string;
let repoDir: string;
let home: string;
let originalHome: string | undefined;
let daemon: DaemonHandle | undefined;

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'driftlock-daemon-test-'));
  repoDir = join(base, 'repo');
  home = join(base, 'driftlock-home');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repoDir });

  originalHome = process.env.HOME;
  process.env.HOME = join(base, 'fake-home');
  mkdirSync(join(process.env.HOME, '.codex', 'sessions'), { recursive: true });
});

afterEach(() => {
  daemon?.stop();
  daemon = undefined;
  if (originalHome === undefined) {
    // biome-ignore lint/performance/noDelete: assigning undefined would stringify to "undefined"
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(base, { recursive: true, force: true });
});

function writeCodexFixture(name: string, fixture: string, cwd: string): void {
  const fixturePath = join(import.meta.dir, '..', '..', '..', 'fixtures', 'codex', fixture);
  const raw = readFileSync(fixturePath, 'utf-8');
  const rewritten = raw.replace('"cwd":"/repo"', `"cwd":${JSON.stringify(cwd)}`);
  writeFileSync(join(process.env.HOME as string, '.codex', 'sessions', name), rewritten);
}

describe('startDaemon', () => {
  test('writes daemon.json with a working port and token', async () => {
    daemon = await startDaemon({ driftlockHomeDir: home });
    const json = readDaemonJson(home);
    expect(json).not.toBeNull();
    expect(json?.port).toBe(daemon.port);
    expect(json?.token).toBe(daemon.token);

    const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(res.status).toBe(200);
  });

  test('drains a pre-existing spool file on startup', async () => {
    const spoolPath = join(home, 'spool');
    mkdirSync(spoolPath, { recursive: true });
    const envelope = { agent: 'codex', event: 'test', cwd: '/repo', receivedAt: 1, payload: {} };
    writeFileSync(join(spoolPath, 'codex.jsonl'), `${JSON.stringify(envelope)}\n`);

    daemon = await startDaemon({ driftlockHomeDir: home });

    const { existsSync } = await import('node:fs');
    expect(existsSync(join(spoolPath, 'codex.jsonl'))).toBe(false);
  });

  test('watches ~/.codex/sessions, ingests a matching session for a registered repo, and stores findings', async () => {
    mkdirSync(home, { recursive: true });
    const registry = openRegistryDb(join(home, 'registry.sqlite'));
    mkdirSync(join(repoDir, '.driftlock'), { recursive: true });
    registry.upsertRepo({
      repoId: 'repo-1',
      root: repoDir,
      name: 'repo',
      agents: ['codex'],
      registeredAt: Date.now(),
      lastSeen: Date.now(),
    });
    registry.close();

    writeCodexFixture('sess.jsonl', 'session-2.jsonl', repoDir);

    daemon = await startDaemon({ driftlockHomeDir: home });

    const repoDb = openRepoDb(repoDbPath(repoDir));
    try {
      await waitUntil(() => repoDb.listSessions({ limit: 1 }).length > 0);
      const [session] = repoDb.listSessions({ limit: 1 });
      expect(session?.agent).toBe('codex');

      await waitUntil(() => repoDb.listFindings({ sessionId: session?.id }).length > 0);
      const findings = repoDb.listFindings({ sessionId: session?.id });
      expect(findings.some((f) => f.analyzer === 'loop')).toBe(true);
    } finally {
      repoDb.close();
    }
  });
});
