import { ClaudeCodeAdapter } from '@driftlock/adapter-claude-code';
import type { LogLevel } from '@driftlock/core';
import { startDaemon } from '@driftlock/daemon';

export interface RunDaemonOptions {
  port?: number;
  logLevel?: LogLevel;
}

/** Starts the daemon in the foreground and resolves once it's listening; caller decides how long to keep the process alive. */
export async function runDaemon(opts: RunDaemonOptions = {}) {
  const daemon = await startDaemon({
    ...(opts.port !== undefined && { port: opts.port }),
    ...(opts.logLevel !== undefined && { logLevel: opts.logLevel }),
    adapters: { 'claude-code': new ClaudeCodeAdapter() },
  });
  console.log(`driftlock daemon listening on 127.0.0.1:${daemon.port} (pid ${process.pid})`);
  return daemon;
}
