#!/usr/bin/env bun
import type { AgentId } from '@driftlock/core';
import { driftlockHome } from '@driftlock/core';
import { runHookClient } from './client.ts';

// Architecture doc §4.1 — the hook client. Reads the agent's JSON payload
// from stdin, wraps it in an envelope, POSTs it to the daemon, and exits.
// Never fails the calling agent: every error path spools and exits 0.
//
// Usage: driftlock-hook <agent> <event> [--wait] [--timeout <ms>]
// `--wait` prints the daemon's JSON response to stdout (for hooks that
// expect context/verdict back, e.g. SessionStart, PreToolUse — wired up in
// later milestones); without it, the client is fire-and-forget.

function parseArgs(argv: string[]): {
  agent: string | undefined;
  event: string | undefined;
  wait: boolean;
  timeoutMs?: number;
} {
  const positional: string[] = [];
  let wait = false;
  let timeoutMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--wait') wait = true;
    else if (arg === '--timeout') timeoutMs = Number(argv[++i]);
    else positional.push(arg);
  }
  return {
    agent: positional[0],
    event: positional[1],
    wait,
    ...(timeoutMs !== undefined && { timeoutMs }),
  };
}

export async function main(argv: string[], stdinText: string): Promise<number> {
  const { agent, event, wait, timeoutMs } = parseArgs(argv);
  if (!agent || !event) {
    // Malformed invocation is our own bug (a bad hook config), not the
    // agent's — still exit 0 so a misconfigured hook can't break the agent.
    console.error(
      'driftlock-hook: usage: driftlock-hook <agent> <event> [--wait] [--timeout <ms>]',
    );
    return 0;
  }

  const result = await runHookClient({
    agent: agent as AgentId,
    event,
    cwd: process.cwd(),
    driftlockHomeDir: driftlockHome(),
    stdinText,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });

  if (wait && result.delivered && result.responseBody !== undefined) {
    process.stdout.write(JSON.stringify(result.responseBody));
  }
  return 0;
}

if (import.meta.main) {
  const stdinText = await Bun.stdin.text().catch(() => '');
  const code = await main(process.argv.slice(2), stdinText);
  process.exit(code);
}
