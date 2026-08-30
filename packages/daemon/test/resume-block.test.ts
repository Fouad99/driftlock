import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFencedBlock, writeResumeBriefToRepo } from '../src/resume-block.ts';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'driftlock-resume-block-test-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('writeFencedBlock', () => {
  test('creates the file with just the fence when it does not exist', () => {
    const path = join(repoRoot, 'CLAUDE.md');
    const result = writeFencedBlock(path, '## brief\nhello');
    expect(result.created).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('<!-- driftlock:resume -->');
    expect(content).toContain('hello');
    expect(content).toContain('<!-- /driftlock:resume -->');
  });

  test('appends the fence to an existing file with no fence, preserving content', () => {
    const path = join(repoRoot, 'CLAUDE.md');
    writeFileSync(path, '# My project\n\nSome instructions.\n');
    writeFencedBlock(path, 'brief v1');
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('# My project');
    expect(content).toContain('Some instructions.');
    expect(content).toContain('brief v1');
  });

  test('is idempotent: re-running replaces only the fenced region', () => {
    const path = join(repoRoot, 'CLAUDE.md');
    writeFileSync(path, '# My project\n\nSome instructions.\n');
    writeFencedBlock(path, 'brief v1');
    writeFencedBlock(path, 'brief v2');

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('# My project');
    expect(content).toContain('Some instructions.');
    expect(content).toContain('brief v2');
    expect(content).not.toContain('brief v1');
    // exactly one fence pair
    expect(content.split('<!-- driftlock:resume -->')).toHaveLength(2);
  });

  test('preserves content that comes after the fence too', () => {
    const path = join(repoRoot, 'CLAUDE.md');
    writeFileSync(
      path,
      '# Before\n\n<!-- driftlock:resume -->\nold brief\n<!-- /driftlock:resume -->\n\n# After\n',
    );
    writeFencedBlock(path, 'new brief');
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('# Before');
    expect(content).toContain('# After');
    expect(content).toContain('new brief');
    expect(content).not.toContain('old brief');
  });
});

describe('writeResumeBriefToRepo', () => {
  test('creates CLAUDE.md and AGENTS.md if absent', () => {
    const results = writeResumeBriefToRepo(repoRoot, 'the brief');
    expect(results.map((r) => r.path.split('/').pop())).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(results.every((r) => r.created)).toBe(true);
    expect(readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf-8')).toContain('the brief');
    expect(readFileSync(join(repoRoot, 'AGENTS.md'), 'utf-8')).toContain('the brief');
  });

  test('only writes .cursor/rules/driftlock.mdc if it already exists', () => {
    let results = writeResumeBriefToRepo(repoRoot, 'v1');
    expect(results).toHaveLength(2); // no cursor rules dir yet

    mkdirSync(join(repoRoot, '.cursor', 'rules'), { recursive: true });
    writeFileSync(join(repoRoot, '.cursor', 'rules', 'driftlock.mdc'), '');

    results = writeResumeBriefToRepo(repoRoot, 'v2');
    expect(results).toHaveLength(3);
    const cursorResult = results.find((r) => r.path.endsWith('driftlock.mdc'));
    expect(cursorResult?.created).toBe(false);
    expect(readFileSync(join(repoRoot, '.cursor', 'rules', 'driftlock.mdc'), 'utf-8')).toContain(
      'v2',
    );
  });
});
