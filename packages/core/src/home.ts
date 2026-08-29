import { platform } from 'node:os';
import { join } from 'node:path';

// Architecture doc §5.5 — <driftlock-home> is $DRIFTLOCK_HOME if set, else
// ~/.driftlock on macOS/Linux and %LOCALAPPDATA%\driftlock on Windows.
export function driftlockHome(
  env: NodeJS.ProcessEnv = process.env,
  os: NodeJS.Platform = platform(),
): string {
  if (env.DRIFTLOCK_HOME) return env.DRIFTLOCK_HOME;
  if (os === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? '', 'AppData', 'Local');
    return join(localAppData, 'driftlock');
  }
  const home = env.HOME ?? '';
  return join(home, '.driftlock');
}
