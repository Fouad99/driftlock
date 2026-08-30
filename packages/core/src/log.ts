import { appendFileSync } from 'node:fs';

// Observability for driftlock itself (not the agent sessions it observes).
// Deliberately hand-rolled and tiny rather than a dependency (pino etc.):
// the hook client's latency budget rules out anything heavy on that path,
// and every other dependency choice in this project has favored small and
// direct over full-featured. Same privacy discipline as judge.log (architecture
// doc §11): callers must never pass raw event payloads/tool output/file
// contents as fields — only shapes, counts, and ids.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface LogEntry extends LogFields {
  ts: number;
  level: LogLevel;
  component: string;
  msg: string;
}

export interface LogSink {
  write(entry: LogEntry): void;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A child logger sharing sinks/level, with `component` scoped as `parent:name`. */
  child(name: string): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Human-readable line to stdout/stderr — for `driftlock daemon` run in the foreground, or CLI --verbose. */
export function createConsoleSink(): LogSink {
  return {
    write(entry) {
      const { ts, level, component, msg, ...fields } = entry;
      const time = new Date(ts).toISOString();
      const extra = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
      const line = `${time} ${level.toUpperCase().padEnd(5)} [${component}] ${msg}${extra}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    },
  };
}

/** JSON-lines to a file — `<driftlock-home>/daemon.log`. Best-effort: a logging failure never crashes the daemon. */
export function createFileSink(path: string): LogSink {
  return {
    write(entry) {
      try {
        appendFileSync(path, `${JSON.stringify(entry)}\n`);
      } catch {
        // best-effort
      }
    },
  };
}

export function createLogger(opts: {
  component: string;
  sinks: LogSink[];
  level?: LogLevel;
}): Logger {
  const level = opts.level ?? 'info';
  const write = (entryLevel: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return;
    const entry: LogEntry = {
      ts: Date.now(),
      level: entryLevel,
      component: opts.component,
      msg,
      ...fields,
    };
    for (const sink of opts.sinks) sink.write(entry);
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (name) =>
      createLogger({ component: `${opts.component}:${name}`, sinks: opts.sinks, level }),
  };
}

/** Default for every optional `logger` param in this codebase — silent, zero cost. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};
