import type { Adapter, AdapterOutput, HookEnvelope, Logger, RegistryStore } from '@driftlock/core';
import { noopLogger, openRepoDb, pathsEqual, repoDbPath, syncSessionIndex } from '@driftlock/core';
import { analyzeAndStore } from './analyze-and-store.ts';
import { applyAdapterOutput } from './apply-adapter-output.ts';
import { generateBrief } from './generate-brief.ts';
import type { ValidatedHookEnvelope } from './hook-envelope.ts';

export interface HookHandlerResult {
  status: number;
  body: { ok: boolean; handled: boolean; note?: string } & Record<string, unknown>;
}

interface ApplyResult {
  duplicate: boolean;
  handledAny: boolean;
  touchedSessionIds: Set<string>;
  endedSessionIds: Set<string>;
}

/**
 * Routes a validated envelope to the matching adapter's `onHook`, applies
 * every resulting `AdapterOutput` (in order — a hook can carry more than
 * one, e.g. Stop's final turn + session_end) to that repo's store, keeps the
 * registry's `session_index` in sync (architecture doc §5.3 — what `status`
 * reads without opening every repo db), and — once per session that ended —
 * runs the analyzers, per architecture doc §4.2. Falls through to
 * `handled: false` (still HTTP 200 — the agent is never blocked) when
 * there's no adapter for this agent yet, or no registered repo matches the
 * hook's cwd.
 *
 * `request`-kind outputs (resume brief, drift verdict) are answered *after*
 * the transaction — `resume_brief` is a plain read (`getLatestBrief`), never
 * something this envelope's own writes need to affect — and the adapter's
 * `reply()` result is merged into the HTTP response body, which is exactly
 * what `--wait` callers print to their hook's stdout (see packages/hook).
 * `pre_edit_verdict` isn't answered yet — that's M6.
 *
 * Idempotent by envelope id, and the claim is atomic: `tryClaimEnvelope`
 * (one `INSERT OR IGNORE`) plus applying every output all happen inside one
 * synchronous `repoDb.transaction()` callback, with no `await` anywhere
 * inside it. Bun/Node's single-threaded event loop guarantees a synchronous
 * callback runs to completion before any other queued request's callback
 * can start — so two concurrent deliveries of the same envelope can't both
 * pass the claim and both apply, the way a separate check-then-later-mark
 * could. `adapter.onHook` (pure translation, no DB writes) runs *before*
 * the transaction so the only thing inside it is synchronous DB work.
 */
export async function handleHookEnvelope(
  envelope: ValidatedHookEnvelope,
  adapters: Partial<Record<HookEnvelope['agent'], Adapter>>,
  registryDb: RegistryStore,
  logger: Logger = noopLogger,
): Promise<HookHandlerResult> {
  const adapter = adapters[envelope.agent];
  if (!adapter?.onHook) {
    logger.debug('no hook handler registered for this agent', { agent: envelope.agent });
    return {
      status: 200,
      body: { ok: true, handled: false, note: `no hook handler registered for ${envelope.agent}` },
    };
  }

  const repo = registryDb.listRepos().find((r) => pathsEqual(r.root, envelope.cwd));
  if (!repo) {
    logger.warn('hook cwd matches no registered repo', {
      agent: envelope.agent,
      cwd: envelope.cwd,
    });
    return {
      status: 200,
      body: { ok: true, handled: false, note: `no registered repo matches cwd ${envelope.cwd}` },
    };
  }

  // Explicit literal (not a spread) so `payload` is always a present key,
  // matching core's `HookEnvelope` regardless of zod's optionality quirk for
  // `unknown`-typed fields (see hook-envelope.ts).
  const normalized: HookEnvelope = {
    id: envelope.id,
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
    const result: ApplyResult = repoDb.transaction(() => {
      if (!repoDb.tryClaimEnvelope(envelope.id)) {
        return {
          duplicate: true,
          handledAny: false,
          touchedSessionIds: new Set(),
          endedSessionIds: new Set(),
        };
      }

      let handledAny = false;
      const touchedSessionIds = new Set<string>();
      const endedSessionIds = new Set<string>();

      for (const output of outputs as AdapterOutput[]) {
        if (output.kind === 'request') continue; // answered after the transaction, below
        const applied = applyAdapterOutput(output, repoDb);
        if (!applied) {
          if (output.kind !== 'session_start') {
            logger.warn('output could not be applied — its session_start may have been missed', {
              outputKind: output.kind,
              sessionId:
                output.kind === 'events' || output.kind === 'session_end'
                  ? output.sessionId
                  : undefined,
            });
          }
          continue;
        }
        handledAny = true;
        touchedSessionIds.add(applied.sessionId);
        if (applied.sessionEnded) endedSessionIds.add(applied.sessionId);
      }

      if (!handledAny) {
        // Nothing was actually persisted (unrecognized output, or the
        // session_start this depends on hasn't arrived yet) — release the
        // claim so a later retry (e.g. once session_start does arrive via
        // the spool) isn't permanently blocked by this no-op having already
        // "applied" the envelope id.
        repoDb.unclaimEnvelope(envelope.id);
      }

      return { duplicate: false, handledAny, touchedSessionIds, endedSessionIds };
    });

    if (result.duplicate) {
      logger.debug('duplicate hook envelope, already applied — no-op', {
        agent: envelope.agent,
        event: envelope.event,
      });
      return { status: 200, body: { ok: true, handled: true, note: 'duplicate, already applied' } };
    }

    // Analysis and registry sync are read-after-write follow-ups, not part
    // of the atomic claim itself — safe to run outside the transaction
    // since they're keyed off session ids the transaction already committed,
    // and `analyzeAndStore` is idempotent (replaces, not appends).
    for (const sessionId of result.endedSessionIds) {
      const findingsCount = await analyzeAndStore(sessionId, repo.root, repoDb, logger);
      logger.info('analyzed session on end', { repoId: repo.repoId, sessionId, findingsCount });
      // Depends on analyzeAndStore's findings already being written — the
      // brief's "unresolved findings" section reads this session's own
      // analysis run, not a stale pre-session_end snapshot.
      await generateBrief(sessionId, repo.root, repoDb, logger);
    }
    for (const sessionId of result.touchedSessionIds) {
      syncSessionIndex(registryDb, repoDb, repo.repoId, sessionId);
    }
    registryDb.upsertRepo({ ...repo, lastSeen: Date.now() });

    let replyBody: Record<string, unknown> = {};
    for (const output of outputs as AdapterOutput[]) {
      if (output.kind !== 'request' || output.type !== 'resume_brief') continue;
      const brief = repoDb.getLatestBrief();
      replyBody = { ...replyBody, ...(output.reply(brief) as Record<string, unknown>) };
    }

    if (!result.handledAny) {
      return {
        status: 200,
        body: {
          ok: true,
          handled: false,
          note: 'nothing applied (unrecognized output, or session_start was missed)',
          ...replyBody,
        },
      };
    }
    return { status: 200, body: { ok: true, handled: true, ...replyBody } };
  } finally {
    repoDb.close();
  }
}
