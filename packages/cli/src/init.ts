import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ClaudeCodeAdapter } from '@driftlock/adapter-claude-code';
import { CodexAdapter } from '@driftlock/adapter-codex';
import type { AgentId, InstallResult, RepoRef } from '@driftlock/core';
import {
  driftlockDir,
  driftlockHome,
  findRepoRoot,
  openRegistryDb,
  openRepoDb,
  readRepoMeta,
  repoDbPath,
  writeRepoMeta,
} from '@driftlock/core';
import { monotonicFactory } from 'ulid';
import { DECISIONS_TEMPLATE } from './decisions-template.ts';

const ulid = monotonicFactory();

const GITIGNORE_ENTRY = '.driftlock/';

export interface InitOptions {
  cwd: string;
  agents?: AgentId[];
}

export interface InitResult {
  repoRoot: string;
  repoId: string;
  agents: AgentId[];
  decisionsCreated: boolean;
  gitignoreUpdated: boolean;
  installResults: { agent: AgentId; result: InstallResult }[];
}

function adapterFor(agent: AgentId) {
  if (agent === 'codex') return new CodexAdapter();
  if (agent === 'claude-code') return new ClaudeCodeAdapter();
  return null; // cursor (M5)
}

function ensureGitignoreEntry(repoRoot: string): boolean {
  const path = join(repoRoot, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  if (existing.split('\n').some((l) => l.trim() === GITIGNORE_ENTRY || l.trim() === '.driftlock')) {
    return false;
  }
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${existing}${sep}${GITIGNORE_ENTRY}\n`);
  return true;
}

function ensureDecisionsFile(repoRoot: string): boolean {
  const path = join(repoRoot, 'DECISIONS.md');
  if (existsSync(path)) return false;
  writeFileSync(path, DECISIONS_TEMPLATE);
  return true;
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const repoRoot = findRepoRoot(opts.cwd);
  if (!repoRoot) {
    throw new Error(`no git repository found at or above ${opts.cwd}`);
  }

  mkdirSync(driftlockDir(repoRoot), { recursive: true });

  const repoDb = openRepoDb(repoDbPath(repoRoot));
  const existingMeta = readRepoMeta(repoRoot);
  const repoId = existingMeta?.repoId ?? repoDb.getMeta('repo_id') ?? ulid();
  repoDb.setMeta('repo_id', repoId);
  repoDb.close();
  writeRepoMeta(repoRoot, { repoId });

  const gitignoreUpdated = ensureGitignoreEntry(repoRoot);
  const decisionsCreated = ensureDecisionsFile(repoRoot);

  const agents = opts.agents ?? (['codex', 'claude-code'] as AgentId[]);
  const ref: RepoRef = { root: repoRoot, repoId };
  const installResults: { agent: AgentId; result: InstallResult }[] = [];
  for (const agent of agents) {
    const adapter = adapterFor(agent);
    if (!adapter) {
      installResults.push({
        agent,
        result: { installed: false, details: `no adapter available yet for ${agent}` },
      });
      continue;
    }
    installResults.push({ agent, result: await adapter.install(ref) });
  }

  mkdirSync(driftlockHome(), { recursive: true });
  const registry = openRegistryDb(join(driftlockHome(), 'registry.sqlite'));
  const now = Date.now();
  registry.upsertRepo({
    repoId,
    root: repoRoot,
    name: basename(repoRoot),
    agents,
    registeredAt: existingMeta ? (registry.getRepo(repoId)?.registeredAt ?? now) : now,
    lastSeen: now,
  });
  registry.close();

  return { repoRoot, repoId, agents, decisionsCreated, gitignoreUpdated, installResults };
}
