import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';

// M3 (05-UI.md §4.1) — "Assets are built once (packages/ui, React + Vite +
// Tailwind) and embedded in the daemon binary / package. No dev server in
// production." A compiled single-binary distribution is M7 (`bun build
// --compile`); for now "embedded in the package" means the daemon serves
// `packages/ui/dist` straight off disk relative to its own install
// location — works identically for a dev checkout and an installed
// `node_modules` tree, and moving to a truly embedded/compiled binary later
// only changes how this path is resolved, not the serving logic below.

/** Default location of the built UI assets, relative to this file's own package. Overridable (`ServerOptions.uiDistDir`) for tests and for a future compiled-binary layout. */
export function defaultUiDistDir(): string {
  return join(import.meta.dir, '..', '..', 'ui', 'dist');
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.'));
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Serves one static asset from `distDir`, or falls back to `index.html`
 * (SPA client-side routing — `/repo/:id/session/:sid` isn't a real file).
 * Returns `null` only when the UI hasn't been built at all (`dist/` or its
 * `index.html` missing) — callers turn that into a clear error rather than
 * a bare 404, since it means a setup problem, not a bad URL. `pathname` is
 * normalized and required to stay under `distDir` so a crafted `..` segment
 * in the URL can't read files outside it.
 */
export function serveStaticAsset(distDir: string, pathname: string): Response | null {
  const indexPath = join(distDir, 'index.html');
  if (!existsSync(indexPath)) return null;

  const relative = normalize(pathname).replace(/^([./\\]+)+/, '');
  const candidate = join(distDir, relative);
  const filePath =
    relative !== '' && candidate.startsWith(distDir) && existsSync(candidate)
      ? candidate
      : indexPath;

  const file = Bun.file(filePath);
  return new Response(file, { headers: { 'content-type': contentTypeFor(filePath) } });
}
