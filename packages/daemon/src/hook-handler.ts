import type { Adapter, HookEnvelope, RegistryStore } from '@driftlock/core';
import { openRepoDb, pathsEqual, repoDbPath, syncSessionIndex } from '@driftlock/core';
import { analyzeAndStore } from './analyze-and-store.ts';
import { applyAdapterOutput } from './apply-adapter-output.ts';
import type { ValidatedHookEnvelope } from './hook-envelope.ts';

export interface HookHandlerResult {
  status: number;
  body: { ok: boolean; handled: boolean; note?: string };
}

/**
 * Routes a validated envelope to the matching adapter's `onHook`, applies
 * every resulting `AdapterOutput` (in order — a hook can carry more than
 * one, e.g. Stop's final turn + session_end) to that repo's store, keeps the
 * registry's `session_index` in sync (architecture doc §5.3 — what `status`
 * reads without opening every repo db), and — once per session that ended —
 * runs the analyzers, per architecture doc §4.2. Falls through to
 * `handled: false` (still HTTP 200 — the agent is never blocked) when
 * there's no adapter for this agent yet, no registered repo matches the
 * hook's cwd, or an output is a `request` kind not implemented until
 * M2/M4/M6.
 */
export async function handleHookEnvelope(
  envelope: ValidatedHookEnvelope,
  adapters: Partial<Record<HookEnvelope['agent'], Adapter>>,
  registryDb: RegistryStore,
): Promise<HookHandlerResult> {
  const adapter = adapters[envelope.agent];
  if (!adapter?.onHook) {
    return {
      status: 200,
      body: { ok: true, handled: false, note: `no hook handler registered for ${envelope.agent}` },
    };
  }

  const repo = registryDb.listRepos().find((r) => pathsEqual(r.root, envelope.cwd));
  if (!repo) {
    return {
      status: 200,
      body: { ok: true, handled: false, note: `no registered repo matches cwd ${envelope.cwd}` },
    };
  }

  // Explicit literal (not a spread) so `payload` is always a present key,
  // matching core's `HookEnvelope` regardless of zod's optionality quirk for
  // `unknown`-typed fields (see hook-envelope.ts).
  const normalized: HookEnvelope = {
    agent: envelope.agent,
    event: envelope.event,
    cwd: envelope.cwd,
    receivedAt: envelope.receivedAt,
    payload: envelope.payload,
  };
  const outputs = await adapter.onHook(normalized, {
    repo: { root: repo.root, repoId: repo.repoId },
  });

  const repoDb = openRepoDb(repoDbPath(repo.root));
  try {
    let handledAny = false;
    const touchedSessionIds = new Set<string>();
    const endedSessionIds = new Set<string>();

    for (const output of outputs) {
      if (output.kind === 'request') continue; // M2/M4/M6
      const applied = applyAdapterOutput(output, repoDb);
      if (!applied) continue;
      handledAny = true;
      touchedSessionIds.add(applied.sessionId);
      if (applied.sessionEnded) endedSessionIds.add(applied.sessionId);
    }

    for (const sessionId of endedSessionIds) {
      await analyzeAndStore(sessionId, repo.root, repoDb);
    }
    for (const sessionId of touchedSessionIds) {
      syncSessionIndex(registryDb, repoDb, repo.repoId, sessionId);
    }
    registryDb.upsertRepo({ ...repo, lastSeen: Date.now() });

    if (!handledAny) {
      return {
        status: 200,
        body: {
          ok: true,
          handled: false,
          note: 'nothing applied (unrecognized output, or session_start was missed)',
        },
      };
    }
    return { status: 200, body: { ok: true, handled: true } };
  } finally {
    repoDb.close();
  }
}
