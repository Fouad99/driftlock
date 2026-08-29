# Fixtures

Synthetic, hand-written transcripts that mimic the structural shape of real
Claude Code and Codex CLI session files, used to develop and test adapters
before real captured sessions are available.

**These are not real captured transcripts.** Implementation plan A-08/M0 calls
for real anonymized ones; replace these with real (anonymized) captures the
first time each adapter is built against a live agent, and keep these as
minimal regression fixtures alongside them.

- `claude-code/session-1.jsonl` — one Claude Code session: session start,
  a user turn, a tool call (Edit) + result, a test run via Bash, a compaction,
  and stop.
- `codex/session-1.jsonl` — one Codex CLI session: a straightforward task with
  a shell command and a patch application.
- `codex/session-2.jsonl` — a second Codex CLI session with a loop-like
  edit/test cycle, for exercising the `loop` analyzer later.
