import type { Adapter, HookEnvelope, RegistryStore } from '@driftlock/core';
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
}

function unauthorized(): Response {
  return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}

export function createServer(opts: ServerOptions): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/health' && req.method === 'GET') {
        return Response.json({ ok: true, version: opts.version, pid: process.pid });
      }

      if (url.pathname === '/hook' && req.method === 'POST') {
        const auth = req.headers.get('authorization');
        if (auth !== `Bearer ${opts.token}`) return unauthorized();

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
        }
        const parsed = HookEnvelopeSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { ok: false, error: 'invalid envelope', issues: parsed.error.issues },
            { status: 400 },
          );
        }

        const result = await handleHookEnvelope(parsed.data, opts.adapters, opts.registryDb);
        return Response.json(result.body, { status: result.status });
      }

      return Response.json({ ok: false, error: 'not found' }, { status: 404 });
    },
  });
}
