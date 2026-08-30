import type { Analyzer, AnalyzerInput, Logger, NewFinding } from '@driftlock/core';
import { noopLogger } from '@driftlock/core';

/**
 * Runs every analyzer over the same input and flattens the findings. Shared
 * by the CLI and the daemon. Isolated per analyzer: one throwing (a bug in
 * that analyzer, or a payload shape it didn't expect) is logged and skipped
 * rather than losing every other analyzer's findings for the session.
 */
export async function runAnalyzers(
  analyzers: Analyzer[],
  input: AnalyzerInput,
  logger: Logger = noopLogger,
): Promise<NewFinding[]> {
  const findings: NewFinding[] = [];
  for (const analyzer of analyzers) {
    try {
      findings.push(...(await analyzer.run(input)));
    } catch (err) {
      logger.error('analyzer failed, skipping', {
        analyzer: analyzer.id,
        sessionId: input.session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return findings;
}
