import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitStatus, headSha, showCommit } from '../src/git.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driftlock-git-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

function initRepo(): void {
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
}

describe('gitStatus', () => {
  test('returns "unavailable" for a directory that is not a git repo', () => {
    expect(gitStatus(dir)).toBe('unavailable');
  });

  test('returns "clean" for a repo with no uncommitted changes', () => {
    initRepo();
    writeFileSync(join(dir, 'a.txt'), 'hello');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-m', 'init']);
    expect(gitStatus(dir)).toBe('clean');
  });

  test('returns "dirty" when there are uncommitted changes', () => {
    initRepo();
    writeFileSync(join(dir, 'a.txt'), 'hello');
    expect(gitStatus(dir)).toBe('dirty');
  });
});

describe('showCommit', () => {
  test('rejects anything that is not a plain hex sha', () => {
    initRepo();
    writeFileSync(join(dir, 'a.txt'), 'hello');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-m', 'init']);
    expect(showCommit(dir, 'HEAD~1')).toBeNull();
    expect(showCommit(dir, '--help')).toBeNull();
    expect(showCommit(dir, 'not-a-sha')).toBeNull();
  });

  test('returns the commit body for a real sha', () => {
    initRepo();
    writeFileSync(join(dir, 'a.txt'), 'hello');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-m', 'init commit']);
    const sha = headSha(dir) as string;
    const show = showCommit(dir, sha);
    expect(show).toContain('init commit');
  });

  test('returns null for a well-formed sha that does not exist', () => {
    initRepo();
    expect(showCommit(dir, 'deadbeef')).toBeNull();
  });
});
