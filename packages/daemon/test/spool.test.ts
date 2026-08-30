import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainSpool, spoolDir } from '../src/spool.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'driftlock-daemon-spool-test-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeSpoolFile(agent: string, lines: string[]): void {
  mkdirSync(spoolDir(home), { recursive: true });
  writeFileSync(join(spoolDir(home), `${agent}.jsonl`), `${lines.join('\n')}\n`);
}

describe('drainSpool', () => {
  test('returns zeros when there is no spool directory', async () => {
    const result = await drainSpool(home, async () => {});
    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  test('processes every valid line and removes the file', async () => {
    const envelope = { agent: 'codex', event: 'test', cwd: '/repo', receivedAt: 1, payload: {} };
    writeSpoolFile('codex', [JSON.stringify(envelope), JSON.stringify(envelope)]);

    const handled: unknown[] = [];
    const result = await drainSpool(home, async (e) => {
      handled.push(e);
    });

    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(handled).toHaveLength(2);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(spoolDir(home), 'codex.jsonl'))).toBe(false);
  });

  test('drops malformed lines without retrying', async () => {
    writeSpoolFile('codex', ['not json', '{"agent":"codex"}']); // missing required fields

    const result = await drainSpool(home, async () => {});
    expect(result).toEqual({ processed: 0, failed: 2 });
  });

  test('keeps lines that fail transiently for the next drain', async () => {
    const envelope = { agent: 'codex', event: 'test', cwd: '/repo', receivedAt: 1, payload: {} };
    writeSpoolFile('codex', [JSON.stringify(envelope)]);

    const result = await drainSpool(home, async () => {
      throw new Error('daemon-side failure');
    });

    expect(result).toEqual({ processed: 0, failed: 1 });
    const remaining = readFileSync(join(spoolDir(home), 'codex.jsonl'), 'utf-8');
    expect(remaining).toContain('"agent":"codex"');
  });
});
