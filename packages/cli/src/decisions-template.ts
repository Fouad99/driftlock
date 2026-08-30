// Architecture doc §7 — DECISIONS.md format. Scaffolded empty by `driftlock init`.
export const DECISIONS_TEMPLATE = `# Decisions

<!--
driftlock reads this file; it never writes to it. Add a decision like:

## D-001 · No ORM in the data layer
- applies: src/data/**, src/db/**
- since: 2026-03-04
- rationale: raw SQL keeps query plans reviewable.

\`applies\` is a list of globs (omit it to apply everywhere). Decisions with
globs are the ones the \`contradiction\` analyzer can check cheaply.
-->
`;
