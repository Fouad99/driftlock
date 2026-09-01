import { describe, expect, test } from 'bun:test';
import {
  BootstrapNonces,
  SESSION_COOKIE_NAME,
  isAuthenticated,
  isTrustedOrigin,
  sessionCookieHeader,
} from '../src/auth.ts';

describe('BootstrapNonces', () => {
  test('a freshly created nonce consumes successfully exactly once', () => {
    const nonces = new BootstrapNonces();
    const nonce = nonces.create();
    expect(nonces.consume(nonce)).toBe(true);
    expect(nonces.consume(nonce)).toBe(false); // replay fails
  });

  test('an unknown nonce never consumes', () => {
    const nonces = new BootstrapNonces();
    expect(nonces.consume('never-issued')).toBe(false);
  });

  test('two different nonces are independent', () => {
    const nonces = new BootstrapNonces();
    const a = nonces.create();
    const b = nonces.create();
    expect(nonces.consume(a)).toBe(true);
    expect(nonces.consume(b)).toBe(true);
  });
});

describe('sessionCookieHeader', () => {
  test('sets HttpOnly, SameSite=Strict, Path=/, and the token as the value', () => {
    const header = sessionCookieHeader('secret-token');
    expect(header).toContain(`${SESSION_COOKIE_NAME}=secret-token`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Path=/');
  });
});

describe('isAuthenticated', () => {
  const token = 'the-token';

  test('accepts a matching bearer token', () => {
    const req = new Request('http://127.0.0.1:1234/api/repos', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(isAuthenticated(req, token)).toBe(true);
  });

  test('accepts a matching session cookie', () => {
    const req = new Request('http://127.0.0.1:1234/api/repos', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    expect(isAuthenticated(req, token)).toBe(true);
  });

  test('accepts the session cookie alongside other unrelated cookies', () => {
    const req = new Request('http://127.0.0.1:1234/api/repos', {
      headers: { cookie: `other=1; ${SESSION_COOKIE_NAME}=${token}; another=2` },
    });
    expect(isAuthenticated(req, token)).toBe(true);
  });

  test('rejects a wrong bearer token and a wrong cookie', () => {
    const req = new Request('http://127.0.0.1:1234/api/repos', {
      headers: { authorization: 'Bearer wrong', cookie: `${SESSION_COOKIE_NAME}=wrong` },
    });
    expect(isAuthenticated(req, token)).toBe(false);
  });

  test('rejects a request with neither', () => {
    const req = new Request('http://127.0.0.1:1234/api/repos');
    expect(isAuthenticated(req, token)).toBe(false);
  });
});

describe('isTrustedOrigin', () => {
  test('accepts a matching Host with no Origin header (top-level navigation)', () => {
    const req = new Request('http://127.0.0.1:1234/api/repos', {
      headers: { host: '127.0.0.1:1234' },
    });
    expect(isTrustedOrigin(req, 1234)).toBe(true);
  });

  test('accepts a matching Host and matching Origin', () => {
    const req = new Request('http://127.0.0.1:1234/api/repos', {
      headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234' },
    });
    expect(isTrustedOrigin(req, 1234)).toBe(true);
  });

  test('rejects a mismatched Origin even with a matching Host', () => {
    const req = new Request('http://127.0.0.1:1234/api/repos', {
      headers: { host: '127.0.0.1:1234', origin: 'http://evil.example' },
    });
    expect(isTrustedOrigin(req, 1234)).toBe(false);
  });

  test('rejects "localhost" — only 127.0.0.1 is trusted', () => {
    const req = new Request('http://127.0.0.1:1234/api/repos', {
      headers: { host: 'localhost:1234' },
    });
    expect(isTrustedOrigin(req, 1234)).toBe(false);
  });

  test('rejects a Host on the wrong port', () => {
    const req = new Request('http://127.0.0.1:1234/api/repos', {
      headers: { host: '127.0.0.1:9999' },
    });
    expect(isTrustedOrigin(req, 1234)).toBe(false);
  });
});
