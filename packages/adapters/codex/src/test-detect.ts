// Architecture doc §4.3 — `test_run` detection from shell commands.
const TEST_COMMAND_PATTERN =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|mocha|pytest|go test|cargo test|rspec)\b/i;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND_PATTERN.test(command);
}

/** Heuristic exit-code inference for agents that don't report one explicitly. */
export function inferExitCode(output: string): number {
  return /\bfail(ed|ing)?\b|\berror\b/i.test(output) ? 1 : 0;
}
