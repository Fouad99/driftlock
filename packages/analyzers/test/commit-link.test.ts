import { describe, expect, test } from 'bun:test';
import { commitLinkAnalyzer } from '../src/commit-link.ts';
import { fakeSession } from './helpers.ts';

describe('commitLinkAnalyzer', () => {
  test('returns nothing without git context', async () => {
    const findings = await commitLinkAnalyzer.run({
      session: fakeSession(),
      events: [],
      previousFindings: [],
    });
    expect(findings).toHaveLength(0);
  });

  test('returns nothing when there are no commits', async () => {
    const findings = await commitLinkAnalyzer.run({
      session: fakeSession(),
      events: [],
      previousFindings: [],
      git: { headBefore: 'abc', headAfter: 'abc', diffPaths: [], commits: [] },
    });
    expect(findings).toHaveLength(0);
  });

  test('reports linked commits', async () => {
    const findings = await commitLinkAnalyzer.run({
      session: fakeSession(),
      events: [],
      previousFindings: [],
      git: { headBefore: 'abc', headAfter: 'def', diffPaths: ['a.ts'], commits: ['abc', 'def'] },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('info');
    expect(findings[0]?.data).toMatchObject({ commits: ['abc', 'def'] });
  });
});
