import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  noopLogger,
  openRegistryDb,
  openRepoDb,
  openSpoolDb,
  repoDbPath,
  spoolDbPath,
} from '@driftlock/core';
import { readDaemonJson } from '../src/daemon-json.ts';
import { type DaemonHandle, startDaemon } from '../src/index.ts';

let base: string;
let repoDir: string;
let home: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
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
  originalUserProfile = process.env.USERPROFILE;
  // codexSessionsDir() reads USERPROFILE on win32, HOME everywhere else
  // (architecture doc §5.5) — both must be overridden for this fake home to
  // actually take effect regardless of which OS the test runs on.
  process.env.HOME = join(base, 'fake-home');
  process.env.USERPROFILE = process.env.HOME;
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
  if (originalUserProfile === undefined) {
    // biome-ignore lint/performance/noDelete: same as above
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
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
    daemon = await startDaemon({ driftlockHomeDir: home, logger: noopLogger });
    const json = readDaemonJson(home);
    expect(json).not.toBeNull();
    expect(json?.port).toBe(daemon.port);
    expect(json?.token).toBe(daemon.token);

    const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(res.status).toBe(200);
  });

  test('drains a pre-existing spool entry on startup', async () => {
    mkdirSync(home, { recursive: true });
    const seedDb = openSpoolDb(spoolDbPath(home));
    seedDb.enqueue({
      id: 'e1',
      agent: 'codex',
      event: 'test',
      cwd: '/repo',
      receivedAt: 1,
      payload: {},
    });
    seedDb.close();

    daemon = await startDaemon({ driftlockHomeDir: home, logger: noopLogger });

    const db = openSpoolDb(spoolDbPath(home));
    expect(db.count()).toBe(0);
    db.close();
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

    daemon = await startDaemon({
      driftlockHomeDir: home,
      logger: noopLogger,
      // The fixture's mtime is already "old" by the time this test runs, so
      // even a near-zero idle threshold is enough for the watcher to treat
      // it as finished on its first pass — real usage defaults to 2 minutes.
      codexIdleThresholdMs: 10,
      codexWatchIntervalMs: 50,
    });

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
