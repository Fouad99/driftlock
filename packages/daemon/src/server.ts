import type { Adapter, HookEnvelope, Logger, RegistryStore } from '@driftlock/core';
import { noopLogger } from '@driftlock/core';
import { HookEnvelopeSchema } from './hook-envelope.ts';
import { handleHookEnvelope } from './hook-handler.ts';

// Architecture doc §4.2/§11 — one loopback HTTP listener; never binds a
// non-loopback address. `/hook` requires the per-install token (A-17); `/api/*`
// and the UI (M3) will share the same listener and the same auth.

export interface ServerOptions {
  port: number;
  token: string;
  version: string;
  adapters: Partial<Record<HookEnvelope['agent'], Adapter>>;
  registryDb: RegistryStore;
  logger?: Logger;
}

function unauthorized(): Response {
  return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}

export function createServer(opts: ServerOptions): ReturnType<typeof Bun.serve> {
  const logger = opts.logger ?? noopLogger;

  return Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    async fetch(req) {
      try {
        const url = new URL(req.url);

        if (url.pathname === '/health' && req.method === 'GET') {
          return Response.json({ ok: true, version: opts.version, pid: process.pid });
        }

        if (url.pathname === '/hook' && req.method === 'POST') {
          const auth = req.headers.get('authorization');
          if (auth !== `Bearer ${opts.token}`) {
            logger.warn('rejected /hook: bad auth token');
            return unauthorized();
          }

          let body: unknown;
          try {
            body = await req.json();
          } catch {
            logger.warn('rejected /hook: invalid JSON body');
            return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
          }
          const parsed = HookEnvelopeSchema.safeParse(body);
          if (!parsed.success) {
            logger.warn('rejected /hook: envelope failed validation', {
              issues: parsed.error.issues.length,
            });
            return Response.json(
              { ok: false, error: 'invalid envelope', issues: parsed.error.issues },
              { status: 400 },
            );
          }

          const start = performance.now();
          const result = await handleHookEnvelope(
            parsed.data,
            opts.adapters,
            opts.registryDb,
            logger,
          );
          logger.info('handled /hook', {
            agent: parsed.data.agent,
            event: parsed.data.event,
            handled: result.body.handled,
            latencyMs: Math.round(performance.now() - start),
          });
          return Response.json(result.body, { status: result.status });
        }

        return Response.json({ ok: false, error: 'not found' }, { status: 404 });
      } catch (err) {
        logger.error('unhandled error in request handler', {
          error: err instanceof Error ? err.message : String(err),
        });
        return Response.json({ ok: false, error: 'internal error' }, { status: 500 });
      }
    },
  });
}
