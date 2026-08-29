# driftlock

Local-first, agent-agnostic observability for AI coding sessions. driftlock turns every session run by Claude Code, Cursor, or Codex CLI into a uniform, per-repository event log; analyzes it for loops, scope creep, untested claims, and drift from decisions you've recorded; and hands the next session a resume brief.

## Status

Early build, milestone M0 (skeleton). Not yet usable — no daemon, no adapters, no CLI commands.

## Development

Requirements: [Bun](https://bun.sh) ≥ 1.1, [pnpm](https://pnpm.io) ≥ 9.

```sh
pnpm install       # install workspace dependencies
bun test           # run the test suite
pnpm run typecheck # tsc --build across all packages
pnpm run lint      # biome check
```

### Layout

```
packages/
  core/               schema (zod), Store (SQLite), Analyzer/Adapter/TaskSource/Judge interfaces
  adapters/
    claude-code/      hooks-based adapter
    cursor/           hooks-based adapter
    codex/            transcript-based adapter
  analyzers/          deterministic + LLM-backed analyzers
  daemon/             resident process: hook receiver, transcript watcher, query API
  cli/                `driftlock` command
  hook/               compiled hook client posted into agent hook configs
  ui/                 local dashboard (React + Vite + Tailwind), served by the daemon
fixtures/             sample agent transcripts used by adapter/analyzer tests
```

CI runs on `ubuntu-latest`, `macos-latest`, and `windows-latest` — see `.github/workflows/ci.yml`. macOS, Linux, and Windows are equal first-class targets; no milestone closes until it passes on all three.
