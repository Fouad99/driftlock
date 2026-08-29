import { platform } from 'node:os';

// Architecture doc §5.5 — all repo paths are normalized (forward slashes
// internally; case-insensitive comparison on Windows and macOS default
// filesystems) before being used as registry keys or in `applies` glob matching.

function isCaseInsensitiveFs(os: NodeJS.Platform = platform()): boolean {
  return os === 'win32' || os === 'darwin';
}

/** Forward slashes, no trailing slash (except root), for internal storage/display. */
export function toPosixPath(input: string): string {
  let p = input.replace(/\\/g, '/');
  if (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }
  return p;
}

/**
 * Key form for comparisons and map lookups: posix-normalized, and lower-cased
 * on filesystems that are case-insensitive by default (Windows, macOS).
 */
export function pathKey(input: string, os: NodeJS.Platform = platform()): string {
  const posix = toPosixPath(input);
  return isCaseInsensitiveFs(os) ? posix.toLowerCase() : posix;
}

export function pathsEqual(a: string, b: string, os: NodeJS.Platform = platform()): boolean {
  return pathKey(a, os) === pathKey(b, os);
}

/** Join posix-style path segments, collapsing duplicate slashes. */
export function joinPosix(...segments: string[]): string {
  return segments
    .map((s, i) => (i === 0 ? toPosixPath(s) : toPosixPath(s).replace(/^\/+/, '')))
    .filter((s) => s.length > 0)
    .join('/');
}
