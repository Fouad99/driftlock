import { describe, expect, test } from 'bun:test';
import { joinPosix, pathKey, pathsEqual, toPosixPath } from '../src/paths.ts';

describe('toPosixPath', () => {
  test('converts backslashes to forward slashes', () => {
    expect(toPosixPath('C:\\Users\\dev\\repo')).toBe('C:/Users/dev/repo');
  });

  test('strips a trailing slash', () => {
    expect(toPosixPath('/repo/src/')).toBe('/repo/src');
  });

  test('leaves the root slash alone', () => {
    expect(toPosixPath('/')).toBe('/');
  });
});

describe('pathKey', () => {
  test('lower-cases on win32', () => {
    expect(pathKey('C:\\Repo\\Src', 'win32')).toBe('c:/repo/src');
  });

  test('lower-cases on darwin', () => {
    expect(pathKey('/Repo/Src', 'darwin')).toBe('/repo/src');
  });

  test('preserves case on linux', () => {
    expect(pathKey('/Repo/Src', 'linux')).toBe('/Repo/Src');
  });
});

describe('pathsEqual', () => {
  test('treats differently-cased paths as equal on windows', () => {
    expect(pathsEqual('C:\\Repo', 'c:\\repo', 'win32')).toBe(true);
  });

  test('treats differently-cased paths as distinct on linux', () => {
    expect(pathsEqual('/Repo', '/repo', 'linux')).toBe(false);
  });
});

describe('joinPosix', () => {
  test('joins segments with a single slash', () => {
    expect(joinPosix('/repo', 'src', 'index.ts')).toBe('/repo/src/index.ts');
  });

  test('collapses duplicate slashes between segments', () => {
    expect(joinPosix('/repo/', '/src/', '/index.ts')).toBe('/repo/src/index.ts');
  });
});
