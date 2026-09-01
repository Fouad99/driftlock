import type { Adapter, HookEnvelope, Logger, RegistryStore, SseEvent } from '@driftlock/core';
import { noopLogger } from '@driftlock/core';
import { BootstrapNonces, isAuthenticated, isTrustedOrigin, sessionCookieHeader } from './auth.ts';
import { UpdateBus } from './bus.ts';
import { HookEnvelopeSchema } from './hook-envelope.ts';
import { handleHookEnvelope } from './hook-handler.ts';
import { handleApiRoute } from './routes.ts';
import { defaultUiDistDir, serveStaticAsset } from './static-assets.ts';

// Architecture doc §4.2/§11 — one loopback HTTP listener; never binds a
// non-loopback address. `/hook` requires the per-install token (A-17); `/api/*`
// and the UI (M3) share the same listener and the same auth.

const SSE_HEARTBEAT_MS = 20_000;

export interface ServerOptions {
  port: number;
  token: string;
  version: string;
  adapters: Partial<Record<HookEnvelope['agent'], Adapter>>;
  registryDb: RegistryStore;
  /** Shared with the caller (`startDaemon`) so hook-driven writes and `/api/*` mutations publish to the same subscribers — see `bus.ts`. Defaults to a private one when omitted (e.g. in tests that don't care about SSE). */
  bus?: UpdateBus;
  /** Overridable for tests; defaults to `packages/ui/dist` next to this package (see `static-assets.ts`). */
  uiDistDir?: string;
  logger?: Logger;
}

function sseFrame(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function unauthorized(): Response {
  return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}

export function createServer(opts: ServerOptions): ReturnType<typeof Bun.serve> {
  const logger = opts.logger ?? noopLogger;
  const bus = opts.bus ?? new UpdateBus();
  const uiDistDir = opts.uiDistDir ?? defaultUiDistDir();
  const bootstrapNonces = new BootstrapNonces();
  // `opts.port` is 0 (bind to any free port) for most test/dev callers;
  // the actually-bound port (needed for Origin/Host checks) is only known
  // once `Bun.serve` returns below, which happens before this closure can
  // ever be invoked by a real request — see the assignment after `bunServer`.
  let boundPort = opts.port;

  const bunServer = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    // Bun's per-connection inactivity timeout defaults to 10s, which would
    // silently kill the long-lived `/api/events` SSE stream — reset on
    // every read/write, so the heartbeat below (well under this) keeps a
    // healthy connection alive indefinitely; a genuinely stalled one still
    // gets reaped.
    idleTimeout: 60,
    async fetch(req) {
      try {
        const url = new URL(req.url);

        if (url.pathname === '/health' && req.method === 'GET') {
          return Response.json({ ok: true, version: opts.version, pid: process.pid });
        }

        // Redeems the CLI-minted nonce (`POST /api/bootstrap` below) for
        // the session cookie — see `auth.ts` for why this is repeatable
        // within its short TTL rather than strictly single-use. Handled
        // ahead of the generic `/api/*` gate since a browser hitting this
        // has no cookie yet by definition.
        if (url.pathname === '/' && url.searchParams.has('bootstrap')) {
          const nonce = url.searchParams.get('bootstrap') as string;
          if (!bootstrapNonces.redeem(nonce)) {
            logger.warn('rejected bootstrap: nonce invalid, expired, or already used');
            return unauthorized();
          }
          return new Response(null, {
            status: 302,
            headers: { Location: '/', 'Set-Cookie': sessionCookieHeader(opts.token) },
          });
        }

        if (url.pathname === '/api/bootstrap' && req.method === 'POST') {
          const auth = req.headers.get('authorization');
          if (auth !== `Bearer ${opts.token}`) {
            logger.warn('rejected /api/bootstrap: bad auth token');
            return unauthorized();
          }
          return Response.json({ nonce: bootstrapNonces.create() });
        }

        // Every `/api/*` route (SSE above, and `routes.ts` below) sits
        // behind this same gate: the cookie or bearer token proves
        // "this caller has the token"; the Origin/Host check on mutations
        // additionally proves "this specific request actually came from
        // our own page", not just from a browser that happens to hold our
        // cookie (auth.ts's `isTrustedOrigin` doc comment).
        if (url.pathname.startsWith('/api/')) {
          if (!isAuthenticated(req, opts.token)) {
            logger.warn('rejected /api/*: not authenticated', { path: url.pathname });
            return unauthorized();
          }
          if (req.method !== 'GET' && !isTrustedOrigin(req, boundPort)) {
            logger.warn('rejected /api/* mutation: untrusted origin', { path: url.pathname });
            return Response.json({ ok: false, error: 'untrusted origin' }, { status: 403 });
          }
        }

        // GET /api/events (SSE, 05-UI.md §4.2) — already past the generic
        // `/api/*` auth gate above. Emits a heartbeat on an interval so a
        // client (and any proxy in between) can tell "still connected,
        // nothing happened" from "connection died silently".
        if (url.pathname === '/api/events' && req.method === 'GET') {
          let unsubscribe: (() => void) | undefined;
          let heartbeat: ReturnType<typeof setInterval> | undefined;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              const send = (event: SseEvent) => {
                try {
                  controller.enqueue(encoder.encode(sseFrame(event)));
                } catch {
                  // Controller already closed (client disconnected between
                  // an event firing and this write) — cleanup below.
                }
              };
              unsubscribe = bus.subscribe(send);
              // Bun doesn't flush the response (headers included, for a
              // fetch()-based client) until the stream's first write —
              // without an immediate frame, a client would see nothing,
              // not even connection confirmation, for a full
              // `SSE_HEARTBEAT_MS`. Send one right away, then on the
              // normal interval.
              send({ type: 'heartbeat' });
              heartbeat = setInterval(() => send({ type: 'heartbeat' }), SSE_HEARTBEAT_MS);
            },
            cancel() {
              unsubscribe?.();
              if (heartbeat) clearInterval(heartbeat);
            },
          });
          return new Response(stream, {
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            },
          });
        }

        if (url.pathname.startsWith('/api/')) {
          const routed = await handleApiRoute(req, url, {
            registryDb: opts.registryDb,
            bus,
            logger,
          });
          if (routed) return routed;
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
            bus,
          );
          logger.info('handled /hook', {
            agent: parsed.data.agent,
            event: parsed.data.event,
            handled: result.body.handled,
            latencyMs: Math.round(performance.now() - start),
          });
          return Response.json(result.body, { status: result.status });
        }

        // The built UI (`packages/ui/dist`) — everything that isn't
        // `/health`, `/hook`, or `/api/*` above. Same auth as `/api/*`
        // (the session cookie set by the bootstrap flow): the static
        // assets themselves carry no secrets, but only a `driftlock ui`
        // invocation (which reads the real bearer token off disk) can mint
        // the nonce that gets that cookie set in the first place, so this
        // still means "only this machine's user, via the CLI, can load the
        // app" rather than any local process that happens to guess the port.
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
          if (!isAuthenticated(req, opts.token)) return unauthorized();
          const asset = serveStaticAsset(uiDistDir, url.pathname);
          if (asset) return asset;
          logger.warn('UI assets not built', { uiDistDir });
          return Response.json(
            {
              ok: false,
              error: `UI assets not found at ${uiDistDir} — run \`bun run build\` in packages/ui`,
            },
            { status: 503 },
          );
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
  boundPort = bunServer.port ?? opts.port;
  return bunServer;
}
