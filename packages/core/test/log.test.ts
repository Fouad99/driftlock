import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LogEntry, createFileSink, createLogger, noopLogger } from '../src/log.ts';

class CollectingSink {
  entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

describe('createLogger', () => {
  test('writes entries at or above the configured level', () => {
    const sink = new CollectingSink();
    const logger = createLogger({ component: 'test', sinks: [sink], level: 'warn' });
    logger.debug('should be dropped');
    logger.info('should be dropped too');
    logger.warn('kept');
    logger.error('kept too');
    expect(sink.entries.map((e) => e.msg)).toEqual(['kept', 'kept too']);
  });

  test('defaults to info level', () => {
    const sink = new CollectingSink();
    const logger = createLogger({ component: 'test', sinks: [sink] });
    logger.debug('dropped');
    logger.info('kept');
    expect(sink.entries).toHaveLength(1);
  });

  test('includes component, level, ts, and extra fields', () => {
    const sink = new CollectingSink();
    const logger = createLogger({ component: 'daemon', sinks: [sink] });
    const before = Date.now();
    logger.info('hook received', { agent: 'codex', handled: true });
    const entry = sink.entries[0];
    expect(entry?.component).toBe('daemon');
    expect(entry?.level).toBe('info');
    expect(entry?.msg).toBe('hook received');
    expect(entry?.agent).toBe('codex');
    expect(entry?.handled).toBe(true);
    expect(entry?.ts).toBeGreaterThanOrEqual(before);
  });

  test('writes to every sink', () => {
    const sinkA = new CollectingSink();
    const sinkB = new CollectingSink();
    const logger = createLogger({ component: 'test', sinks: [sinkA, sinkB] });
    logger.info('x');
    expect(sinkA.entries).toHaveLength(1);
    expect(sinkB.entries).toHaveLength(1);
  });

  test('child() scopes the component and shares sinks/level', () => {
    const sink = new CollectingSink();
    const logger = createLogger({ component: 'daemon', sinks: [sink], level: 'warn' });
    const child = logger.child('watcher');
    child.debug('dropped, inherits warn level');
    child.warn('kept');
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.component).toBe('daemon:watcher');
  });
});

describe('noopLogger', () => {
  test('never throws and child() returns itself', () => {
    expect(() => {
      noopLogger.debug('x');
      noopLogger.info('x');
      noopLogger.warn('x');
      noopLogger.error('x');
    }).not.toThrow();
    expect(noopLogger.child('x')).toBe(noopLogger);
  });
});

describe('createFileSink', () => {
  test('appends JSON lines to the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'driftlock-log-test-'));
    try {
      const path = join(dir, 'daemon.log');
      const logger = createLogger({ component: 'daemon', sinks: [createFileSink(path)] });
      logger.info('started', { port: 1234 });
      logger.warn('watcher fell back to polling');

      const lines = readFileSync(path, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0] as string);
      expect(first.msg).toBe('started');
      expect(first.port).toBe(1234);
      const second = JSON.parse(lines[1] as string);
      expect(second.level).toBe('warn');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never throws even if the directory does not exist', () => {
    const logger = createLogger({
      component: 'x',
      sinks: [createFileSink('/nonexistent-dir-xyz/daemon.log')],
    });
    expect(() => logger.info('x')).not.toThrow();
  });
});
