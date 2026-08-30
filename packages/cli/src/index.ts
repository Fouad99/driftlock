#!/usr/bin/env bun
import type { AgentId, Logger } from '@driftlock/core';
import { createConsoleSink, createLogger, noopLogger } from '@driftlock/core';
import { runDaemon } from './daemon-command.ts';
import { runDoctor } from './doctor.ts';
import { formatDoctor, formatExplain, formatReport, formatStatus } from './format.ts';
import { runInit } from './init.ts';
import { runReport } from './report.ts';
import { runStatus } from './status.ts';

function parseFlags(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (argv[i + 1] && !argv[i + 1]?.startsWith('--')) {
        flags.set(arg.slice(2), argv[++i] as string);
      } else {
        flags.set(arg.slice(2), true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** `--verbose` turns on debug-level console logging for the command; otherwise the CLI stays silent apart from its normal output. */
function loggerFor(flags: Map<string, string | true>): Logger {
  if (!flags.get('verbose')) return noopLogger;
  return createLogger({ component: 'cli', sinks: [createConsoleSink()], level: 'debug' });
}

async function cmdInit(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const agentsFlag = flags.get('agents');
  const agents = typeof agentsFlag === 'string' ? (agentsFlag.split(',') as AgentId[]) : undefined;

  const result = await runInit({
    cwd: process.cwd(),
    logger: loggerFor(flags),
    ...(agents && { agents }),
  });

  if (flags.get('json')) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.log(`Initialized driftlock in ${result.repoRoot}`);
  console.log(`  repo id: ${result.repoId}`);
  console.log(`  agents: ${result.agents.join(', ')}`);
  console.log(`  DECISIONS.md: ${result.decisionsCreated ? 'created' : 'already present'}`);
  console.log(`  .gitignore: ${result.gitignoreUpdated ? 'updated' : 'already up to date'}`);
  for (const { agent, result: install } of result.installResults) {
    console.log(
      `  ${agent}: ${install.installed ? 'installed' : 'not installed'} — ${install.details}`,
    );
  }
  return 0;
}

async function cmdReport(argv: string[]): Promise<number> {
  const { positional, flags } = parseFlags(argv);
  const sessionId = positional[0];

  const result = await runReport({
    cwd: process.cwd(),
    logger: loggerFor(flags),
    ...(sessionId && { sessionId }),
  });

  if (flags.get('json')) {
    console.log(JSON.stringify({ session: result.session, findings: result.findings }, null, 2));
    return 0;
  }

  console.log(formatReport(result.session, result.findings));
  if (flags.get('explain')) {
    console.log(formatExplain(result.findings, result.events));
  }
  return 0;
}

async function cmdStatus(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const rows = await runStatus();

  if (flags.get('json')) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  console.log(formatStatus(rows));
  return 0;
}

async function cmdDoctor(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const report = await runDoctor(process.cwd());

  if (flags.get('json')) {
    console.log(JSON.stringify(report, null, 2));
    return report.checks.some((c) => c.status === 'fail') ? 1 : 0;
  }

  console.log(formatDoctor(report.checks));
  return report.checks.some((c) => c.status === 'fail') ? 1 : 0;
}

async function cmdDaemon(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const portFlag = flags.get('port');
  const port = typeof portFlag === 'string' ? Number(portFlag) : undefined;

  const daemon = await runDaemon({
    ...(port !== undefined && { port }),
    ...(flags.get('verbose') && { logLevel: 'debug' as const }),
  });

  return new Promise<number>((resolve) => {
    const shutdown = () => {
      daemon.stop();
      resolve(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    switch (command) {
      case 'init':
        return await cmdInit(rest);
      case 'report':
        return await cmdReport(rest);
      case 'status':
        return await cmdStatus(rest);
      case 'doctor':
        return await cmdDoctor(rest);
      case 'daemon':
        return await cmdDaemon(rest);
      case undefined:
      case '--help':
      case '-h':
        console.log('Usage: driftlock <init|report|status|doctor|daemon> [options]');
        return command === undefined ? 1 : 0;
      default:
        console.error(`Unknown command: ${command}`);
        return 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

export { cmdInit, cmdReport, cmdStatus, cmdDoctor, cmdDaemon, main };
