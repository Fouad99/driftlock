import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStaticAsset } from '../src/static-assets.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driftlock-static-assets-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('serveStaticAsset', () => {
  test('returns null when the UI has not been built (no index.html)', () => {
    expect(serveStaticAsset(dir, '/')).toBeNull();
  });

  test('serves a real file under the dist dir with the right content-type', async () => {
    writeFileSync(join(dir, 'index.html'), '<html>app shell</html>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'index.js'), 'console.log(1)');

    const res = serveStaticAsset(dir, '/assets/index.js') as Response;
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(await res.text()).toBe('console.log(1)');
  });

  test('falls back to index.html for a client-side route (SPA fallback)', async () => {
    writeFileSync(join(dir, 'index.html'), '<html>app shell</html>');

    const res = serveStaticAsset(dir, '/repo/x/session/y') as Response;
    expect(await res.text()).toBe('<html>app shell</html>');
  });

  test('falls back to index.html rather than escaping the dist dir on a path-traversal attempt', async () => {
    writeFileSync(join(dir, 'index.html'), '<html>app shell</html>');
    const secretDir = mkdtempSync(join(tmpdir(), 'driftlock-static-assets-secret-'));
    writeFileSync(join(secretDir, 'secret.txt'), 'do not serve me');

    const res = serveStaticAsset(dir, `/../${join(secretDir, 'secret.txt')}`) as Response;
    expect(await res.text()).toBe('<html>app shell</html>');
    rmSync(secretDir, { recursive: true, force: true });
  });
});
