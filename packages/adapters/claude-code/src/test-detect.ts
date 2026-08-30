// Small, deliberately-duplicated copy of the Codex adapter's test-command
// heuristic — adapters are independent packages (architecture doc §4.3:
// "only adapters know which agent produced an event"); this is two lines,
// not worth a cross-adapter dependency.
const TEST_COMMAND_PATTERN =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|mocha|pytest|go test|cargo test|rspec)\b/i;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND_PATTERN.test(command);
}
