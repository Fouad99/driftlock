import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexSessionsDir } from '@driftlock/adapter-codex';
import {
  driftlockHome,
  findRepoRoot,
  openRegistryDb,
  openRepoDb,
  readRepoMeta,
  repoDbPath,
} from '@driftlock/core';
import type { LogEntry } from '@driftlock/core';
import { daemonJsonPath, daemonLogPath, readDaemonJson } from '@driftlock/daemon';

// Usage doc — `driftlock doctor`: "Checks: daemon running and reachable;
// hooks installed for each agent; transcript directories exist; registry and
// repo databases consistent; hook round-trip latency; unknown-event rate per
// adapter." Repo-scoped checks (hooks installed, registry consistency,
// unknown-event rate) only run when `cwd` is inside a driftlock repo.

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
}

async function checkDaemon(): Promise<{ checks: DoctorCheck[]; port?: number; token?: string }> {
  const home = driftlockHome();
  const daemonInfo = readDaemonJson(home);
  if (!daemonInfo) {
    return {
      checks: [
        {
          name: 'daemon',
          status: 'warn',
          detail: `no daemon.json at ${daemonJsonPath(home)} — is the daemon running?`,
        },
      ],
    };
  }

  try {
    const res = await fetch(`http://127.0.0.1:${daemonInfo.port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) {
      return {
        checks: [
          { name: 'daemon', status: 'fail', detail: `daemon responded with HTTP ${res.status}` },
        ],
      };
    }
    return {
      checks: [
        {
          name: 'daemon',
          status: 'ok',
          detail: `reachable on 127.0.0.1:${daemonInfo.port} (pid ${daemonInfo.pid})`,
        },
      ],
      port: daemonInfo.port,
      token: daemonInfo.token,
    };
  } catch {
    return {
      checks: [
        {
          name: 'daemon',
          status: 'fail',
          detail: `daemon.json points at port ${daemonInfo.port} but it's not reachable — stale? hooks will spool until it's restarted`,
        },
      ],
    };
  }
}

async function checkHookLatency(port: number, token: string): Promise<DoctorCheck> {
  const start = performance.now();
  try {
    await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        agent: 'codex',
        event: 'doctor-probe',
        cwd: process.cwd(),
        receivedAt: Date.now(),
        payload: {},
      }),
      signal: AbortSignal.timeout(1000),
    });
    const latencyMs = Math.round(performance.now() - start);
    return {
      name: 'hook round-trip',
      status: latencyMs > 300 ? 'warn' : 'ok',
      detail: `${latencyMs} ms`,
    };
  } catch {
    return { name: 'hook round-trip', status: 'fail', detail: 'request failed' };
  }
}

const LOG_TAIL_LINES = 500;

function checkDaemonLog(): DoctorCheck {
  const path = daemonLogPath(driftlockHome());
  if (!existsSync(path)) {
    return { name: 'daemon.log', status: 'warn', detail: `no log file yet at ${path}` };
  }

  const lines = readFileSync(path, 'utf-8').trim().split('\n').slice(-LOG_TAIL_LINES);
  let lastError: LogEntry | undefined;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as LogEntry;
      if (entry.level === 'error') lastError = entry;
    } catch {
      // a malformed line in our own log is odd but shouldn't break doctor
    }
  }

  if (!lastError) {
    return {
      name: 'daemon.log',
      status: 'ok',
      detail: `no errors in the last ${lines.length} line(s)`,
    };
  }
  return {
    name: 'daemon.log',
    status: 'warn',
    detail: `most recent error (${new Date(lastError.ts).toISOString()}): ${lastError.msg}`,
  };
}

function checkCodexTranscriptDir(): DoctorCheck {
  const dir = codexSessionsDir();
  return existsSync(dir)
    ? { name: 'codex transcript directory', status: 'ok', detail: dir }
    : {
        name: 'codex transcript directory',
        status: 'warn',
        detail: `${dir} does not exist yet (no Codex sessions run here)`,
      };
}

function checkRepoChecks(cwd: string): DoctorCheck[] {
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) {
    return [
      {
        name: 'repo',
        status: 'warn',
        detail: 'not inside a git repository — skipping repo-scoped checks',
      },
    ];
  }

  const checks: DoctorCheck[] = [];
  const meta = readRepoMeta(repoRoot);
  if (!meta) {
    checks.push({
      name: 'repo init',
      status: 'warn',
      detail: `${repoRoot} has no .driftlock/meta.json — run \`driftlock init\``,
    });
    return checks;
  }
  checks.push({ name: 'repo init', status: 'ok', detail: `repo id ${meta.repoId}` });

  const registryDb = openRegistryDb(join(driftlockHome(), 'registry.sqlite'));
  try {
    const registered = registryDb.getRepo(meta.repoId);
    checks.push(
      registered
        ? { name: 'registry consistency', status: 'ok', detail: 'repo is registered' }
        : {
            name: 'registry consistency',
            status: 'fail',
            detail: `repo id ${meta.repoId} is not in the registry — re-run \`driftlock init\``,
          },
    );
  } finally {
    registryDb.close();
  }

  const claudeSettingsPath = join(repoRoot, '.claude', 'settings.json');
  if (existsSync(claudeSettingsPath)) {
    const wired = readFileSync(claudeSettingsPath, 'utf-8').includes('"driftlock-hook"');
    checks.push({
      name: 'claude-code hooks',
      status: wired ? 'ok' : 'warn',
      detail: wired
        ? `wired in ${claudeSettingsPath}`
        : `${claudeSettingsPath} exists but driftlock-hook isn't wired`,
    });
  } else {
    checks.push({
      name: 'claude-code hooks',
      status: 'warn',
      detail: 'no .claude/settings.json — Claude Code hooks not installed',
    });
  }

  const repoDb = openRepoDb(repoDbPath(repoRoot));
  try {
    const sessions = repoDb.listSessions({ limit: 50 });
    let total = 0;
    let raw = 0;
    for (const s of sessions) {
      for (const e of repoDb.getEvents(s.id)) {
        total += 1;
        if (e.kind === 'raw') raw += 1;
      }
    }
    const rate = total > 0 ? raw / total : 0;
    checks.push({
      name: 'unknown-event rate',
      status: rate > 0.1 ? 'warn' : 'ok',
      detail:
        total === 0
          ? 'no events yet'
          : `${Math.round(rate * 100)}% of events (${raw}/${total}) across the last ${sessions.length} session(s)`,
    });
  } finally {
    repoDb.close();
  }

  return checks;
}

export async function runDoctor(cwd: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const daemonResult = await checkDaemon();
  checks.push(...daemonResult.checks);
  if (daemonResult.port !== undefined && daemonResult.token !== undefined) {
    checks.push(await checkHookLatency(daemonResult.port, daemonResult.token));
  }

  checks.push(checkDaemonLog());
  checks.push(checkCodexTranscriptDir());
  checks.push(...checkRepoChecks(cwd));

  return { checks };
}
