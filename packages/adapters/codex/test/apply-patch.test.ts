import { describe, expect, test } from 'bun:test';
import { parseApplyPatch } from '../src/apply-patch.ts';

describe('parseApplyPatch', () => {
  test('parses a single-file, single-hunk patch', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/api/login.ts',
      '@@',
      "-app.post('/login', handler)",
      "+app.post('/login', rateLimit, handler)",
      '*** End Patch',
    ].join('\n');

    const edits = parseApplyPatch(patch);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.path).toBe('src/api/login.ts');
    expect(edits[0]?.hunks).toHaveLength(1);
    expect(edits[0]?.hunks[0]?.oldLines).toBe(1);
    expect(edits[0]?.hunks[0]?.newLines).toBe(1);
  });

  test('parses multiple files in one patch', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      '-old a',
      '+new a',
      '*** Update File: b.ts',
      '@@',
      '-old b',
      '+new b',
      '+new b2',
      '*** End Patch',
    ].join('\n');

    const edits = parseApplyPatch(patch);
    expect(edits.map((e) => e.path)).toEqual(['a.ts', 'b.ts']);
    expect(edits[1]?.hunks[0]?.newLines).toBe(2);
  });
});
