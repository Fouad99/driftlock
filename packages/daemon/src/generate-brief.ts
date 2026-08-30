import { TranscriptTaskSource } from '@driftlock/analyzers';
import type { Logger, RepoStore } from '@driftlock/core';
import { currentBranch, isDirty, noopLogger } from '@driftlock/core';
import { writeResumeBriefToRepo } from './resume-block.ts';

// Architecture doc §8.1 — resume brief. Generated at `session_end` for the
// *next* session (stored against this, the source, session — see
// brief.ts's note on why; `RepoStore.getLatestBrief()` is what a session
// starting next actually reads).
//
// Content, capped to stay under the doc's ≤60-line budget: last session
// date/agent, what was in progress, unresolved findings, dirty branch, next
// task. "Decisions relevant to recently touched paths" (doc's own list) is
// deliberately omitted — no `DecisionLog` parser exists yet (that's M4); add
// this section once `@driftlock/core`'s decision parsing lands.

const MAX_PLAN_ITEMS = 5;
const MAX_FINDINGS = 10;
const AGENT_TURN_TRUNCATE = 400;
const PLAN_ITEM_TRUNCATE = 120;

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** No-op (does not touch `briefs`) unless the session has actually ended — a brief generated from an in-flight session would be stale by the time anyone reads it. */
export async function generateBrief(
  sessionId: string,
  repoRoot: string,
  repoDb: RepoStore,
  logger: Logger = noopLogger,
): Promise<void> {
  const session = repoDb.getSession(sessionId);
  if (!session || session.endedAt === null) return;

  const events = repoDb.getEvents(sessionId);
  const taskSource = new TranscriptTaskSource(repoDb);
  const nextTask = await taskSource.next(repoRoot);

  const lastAgentTurn = [...events].reverse().find((e) => e.kind === 'agent_turn');
  const planItems = events.filter((e) => e.kind === 'plan_item').slice(-MAX_PLAN_ITEMS);
  const findings = repoDb.listFindings({ open: true }).slice(0, MAX_FINDINGS);
  const branch = currentBranch(repoRoot);
  const dirty = isDirty(repoRoot);

  const lines: string[] = ['# Resume brief', ''];

  const meta = [
    `Last session: ${new Date(session.startedAt).toISOString().slice(0, 10)}`,
    session.agent,
    branch ? `branch \`${branch}\`` : null,
    dirty ? 'uncommitted changes' : null,
  ].filter(Boolean);
  lines.push(`_${meta.join(' · ')}_`, '');

  lines.push('## In progress');
  if (planItems.length > 0) {
    for (const p of planItems) {
      if (p.kind !== 'plan_item') continue;
      lines.push(`- [${p.payload.status}] ${truncate(p.payload.text, PLAN_ITEM_TRUNCATE)}`);
    }
  } else if (lastAgentTurn?.kind === 'agent_turn') {
    lines.push(truncate(lastAgentTurn.payload.text, AGENT_TURN_TRUNCATE));
  } else {
    lines.push('_nothing captured_');
  }
  lines.push('');

  lines.push(`## Unresolved findings (${findings.length})`);
  if (findings.length > 0) {
    for (const f of findings) lines.push(`- [${f.severity}] ${f.title} (${f.analyzer})`);
  } else {
    lines.push('_none_');
  }
  lines.push('');

  lines.push('## Next task');
  lines.push(nextTask ? nextTask.text : '_none captured_');

  const markdown = lines.join('\n');
  repoDb.upsertBrief({ sessionId, generatedAt: Date.now(), markdown });
  // Universal delivery path (§8.1) — every agent, not just ones with
  // `resumeInject`, reads its own instruction file on its own.
  const written = writeResumeBriefToRepo(repoRoot, markdown);
  logger.info('generated resume brief', {
    sessionId,
    findingsCount: findings.length,
    writtenTo: written.map((w) => w.path),
  });
}
