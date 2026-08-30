import { join } from 'node:path';
import { findAndIngestCodexSessions } from '@driftlock/adapter-codex';
import { DETERMINISTIC_ANALYZERS, runAnalyzers } from '@driftlock/analyzers';
import type { Event, Finding, Logger, Session } from '@driftlock/core';
import {
  buildGitContext,
  driftlockHome,
  findRepoRoot,
  noopLogger,
  openRegistryDb,
  openRepoDb,
  readRepoMeta,
  repoDbPath,
  syncSessionIndex,
} from '@driftlock/core';
import { deriveTask } from './task.ts';

export interface ReportOptions {
  cwd: string;
  sessionId?: string;
  logger?: Logger;
}

export interface ReportResult {
  repoRoot: string;
  session: Session;
  events: Event[];
  findings: Finding[];
}

export async function runReport(opts: ReportOptions): Promise<ReportResult> {
  const logger = opts.logger ?? noopLogger;
  const repoRoot = findRepoRoot(opts.cwd);
  if (!repoRoot) throw new Error(`no git repository found at or above ${opts.cwd}`);

  const repoDb = openRepoDb(repoDbPath(repoRoot));
  try {
    const ingested = await findAndIngestCodexSessions(repoRoot, repoDb);
    if (ingested.length > 0)
      logger.debug('ingested new codex sessions', { count: ingested.length });

    let session: Session | null;
    if (opts.sessionId) {
      session = repoDb.getSession(opts.sessionId);
      if (!session) throw new Error(`no session ${opts.sessionId} found in this repo`);
    } else {
      const [latest] = repoDb.listSessions({ limit: 1 });
      if (!latest)
        throw new Error(
          'no sessions found for this repo yet — run an agent, or check `driftlock doctor`',
        );
      session = latest;
    }
    logger.debug('reporting on session', { sessionId: session.id, agent: session.agent });

    const events = repoDb.getEvents(session.id);
    const task = deriveTask(session, events);
    const git = buildGitContext(repoRoot, session.headBefore, session.headAfter) ?? undefined;
    const previousFindings = repoDb
      .listFindings({ open: true })
      .filter((f) => f.sessionId !== session.id);

    const newFindings = await runAnalyzers(
      DETERMINISTIC_ANALYZERS,
      {
        session,
        events,
        previousFindings,
        ...(task && { task }),
        ...(git && { git }),
      },
      logger,
    );
    const findings = newFindings.map((f) => repoDb.createFinding(f));
    logger.debug('analyzers finished', {
      eventCount: events.length,
      findingsCount: findings.length,
    });

    const repoId = readRepoMeta(repoRoot)?.repoId;
    if (repoId) {
      const registryDb = openRegistryDb(join(driftlockHome(), 'registry.sqlite'));
      try {
        syncSessionIndex(registryDb, repoDb, repoId, session.id);
      } finally {
        registryDb.close();
      }
    }

    return { repoRoot, session, events, findings };
  } finally {
    repoDb.close();
  }
}
