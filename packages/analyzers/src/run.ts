import type { Analyzer, AnalyzerInput, NewFinding } from '@driftlock/core';

/** Runs every analyzer over the same input and flattens the findings. Shared by the CLI and the daemon. */
export async function runAnalyzers(
  analyzers: Analyzer[],
  input: AnalyzerInput,
): Promise<NewFinding[]> {
  const findings: NewFinding[] = [];
  for (const analyzer of analyzers) {
    findings.push(...(await analyzer.run(input)));
  }
  return findings;
}
