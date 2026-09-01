import { randomUUID } from 'node:crypto';

// M3 auth bootstrap (05-UI.md §3) — gets the daemon's bearer token into an
// HttpOnly cookie for the browser without ever putting the token itself in
// a URL. Built on `node:crypto` and a plain in-memory map, matching how the
// rest of the daemon is built (raw `Bun.serve`, no framework) — the surface
// here is small enough that a session/cookie library would be solving
// problems this single-user, single-process, localhost-only daemon doesn't
// have.
//
// The cookie's value IS the daemon's real bearer token — there is no
// separate session concept to track or expire. The nonce's only job is to
// be the thing that briefly appears in a URL (shell history, the browser's
// address bar) instead of the token itself; it's random and short-lived, so
// a leaked nonce is worthless once it expires.
//
// Deliberately NOT single-use (an earlier version deleted a nonce on its
// first check): in practice, browsers and OS-level link handling routinely
// make an HTTP request to a freshly-opened URL before the user's own
// navigation lands — link previews, safe-browsing/link-scanning, address
// bar preconnect/prefetch. Any of those silently burns a strictly one-time
// token, so the user's actual click 404/401s even though a cookie already
// got set moments earlier from the same URL (confusing: the app *works* if
// you then load `/` directly, just not via the link you were handed).
// Tolerating repeat redemption within the short TTL window costs nothing
// real here — the threat this defends against (someone else on the machine
// reading the URL out of shell history/terminal scrollback) is exactly as
// mitigated by "expires in seconds" alone as it was by "single-use", since
// either way the window to exploit a leaked nonce is the same few seconds.
const NONCE_TTL_MS = 30_000;

export const SESSION_COOKIE_NAME = 'driftlock_session';

export class BootstrapNonces {
  private pending = new Map<string, number>(); // nonce -> expiresAt

  create(): string {
    this.sweep();
    const nonce = randomUUID();
    this.pending.set(nonce, Date.now() + NONCE_TTL_MS);
    return nonce;
  }

  /** Valid until `NONCE_TTL_MS` after minting — repeatable within that window (see the class-level comment on why this isn't single-use). */
  redeem(nonce: string): boolean {
    const expiresAt = this.pending.get(nonce);
    return expiresAt !== undefined && Date.now() < expiresAt;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.pending) {
      if (now >= expiresAt) this.pending.delete(nonce);
    }
  }
}

export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** True if the request authenticates either via bearer token (hook client, scripted/CLI-driven calls) or the session cookie (the browser, after bootstrap). */
export function isAuthenticated(req: Request, token: string): boolean {
  if (req.headers.get('authorization') === `Bearer ${token}`) return true;
  return readCookie(req, SESSION_COOKIE_NAME) === token;
}

/**
 * Mutating `/api/*` requests only. The session cookie alone proves "some
 * browser on this machine has the token" — it says nothing about which page
 * sent *this* request; a cookie is attached automatically by the browser to
 * any same-origin-looking request, which is exactly the shape of a CSRF
 * attack. Reject any state-changing request whose `Host`/`Origin` doesn't
 * match this daemon's own address. `127.0.0.1` only, never `localhost` —
 * per `05-UI.md` §3, so the two can't quietly disagree.
 */
export function isTrustedOrigin(req: Request, port: number): boolean {
  const expectedHost = `127.0.0.1:${port}`;
  if (req.headers.get('host') !== expectedHost) return false;
  const origin = req.headers.get('origin');
  // No Origin header at all (e.g. a same-page top-level navigation) is
  // allowed through on Host alone; when Origin IS present, it must agree.
  return origin === null || origin === `http://${expectedHost}`;
}
