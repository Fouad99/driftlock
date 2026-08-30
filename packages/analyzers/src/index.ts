import type { Analyzer } from '@driftlock/core';
import { commitLinkAnalyzer } from './commit-link.ts';
import { compactionAnalyzer } from './compaction.ts';
import { loopAnalyzer } from './loop.ts';
import { rereadAnalyzer } from './reread.ts';
import { revertAnalyzer } from './revert.ts';
import { scopeAnalyzer } from './scope.ts';
import { testBeforeClaimAnalyzer } from './test-before-claim.ts';

export { compactionAnalyzer } from './compaction.ts';
export { rereadAnalyzer } from './reread.ts';
export { loopAnalyzer } from './loop.ts';
export { revertAnalyzer } from './revert.ts';
export { testBeforeClaimAnalyzer } from './test-before-claim.ts';
export { scopeAnalyzer } from './scope.ts';
export { commitLinkAnalyzer } from './commit-link.ts';
export { runAnalyzers } from './run.ts';

// Matches usage doc's default `[analyzers] enabled` list.
export const DETERMINISTIC_ANALYZERS: Analyzer[] = [
  compactionAnalyzer,
  rereadAnalyzer,
  loopAnalyzer,
  revertAnalyzer,
  testBeforeClaimAnalyzer,
  scopeAnalyzer,
  commitLinkAnalyzer,
];
