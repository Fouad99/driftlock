import type { Logger, RegistryStore } from '@driftlock/core';
import { noopLogger, openRepoDb, repoDbPath } from '@driftlock/core';
import type { UpdateBus } from './bus.ts';
import { resolveFindingMutation, setFindingPinnedMutation } from './mutations.ts';
import {
  type TimelineFilter,
  getCommitDetail,
  getEvidenceForFinding,
  getRepoRows,
  getSessionDetail,
  getTimelinePage,
} from './queries.ts';

// M3 (05-UI.md §4.2) — the actual `/api/*` route handlers, scoped to the
// M3/UI-1 endpoint set only (see that doc's "Full table below is the
// eventual shape..." note). Every handler here is a thin adapter over
// `queries.ts`/`mutations.ts` — no query/mutation logic lives in this file,
// so the CLI and HTTP can never diverge (05-UI.md: "the HTTP layer is a
// transport, not a second API").
//
// Dispatch is a plain path-segment match, matching the rest of the daemon's
// style (raw `Bun.serve`, no router library — see `server.ts`). Returns
// `null` for anything under `/api/` this function doesn't recognize, so
// `server.ts` falls through to its normal 404.

export interface RouteContext {
  registryDb: RegistryStore;
  bus: UpdateBus;
  logger?: Logger;
}

function notFound(error: string): Response {
  return Response.json({ ok: false, error }, { status: 404 });
}

function badRequest(error: string): Response {
  return Response.json({ ok: false, error }, { status: 400 });
}

export async function handleApiRoute(
  req: Request,
  url: URL,
  ctx: RouteContext,
): Promise<Response | null> {
  const logger = ctx.logger ?? noopLogger;
  const parts = url.pathname.split('/').filter(Boolean); // "/api/repos/x" -> ['api','repos','x']
  if (parts[0] !== 'api' || parts[1] !== 'repos') return null;

  if (parts.length === 2) {
    if (req.method !== 'GET') return null;
    return Response.json({ repos: getRepoRows(ctx.registryDb) });
  }

  const repoId = parts[2] as string;
  const repo = ctx.registryDb.getRepo(repoId);
  if (!repo) return notFound(`no such repo: ${repoId}`);

  if (parts.length === 3) {
    if (req.method !== 'GET') return null;
    const repoDb = openRepoDb(repoDbPath(repo.root));
    try {
      return Response.json({
        repo,
        sessions: repoDb.listSessions({ limit: 20 }),
        brief: repoDb.getLatestBrief(),
      });
    } finally {
      repoDb.close();
    }
  }

  // /api/repos/:id/sessions/:sid[/events[/:seq]][/evidence]
  if (parts[3] === 'sessions' && parts[4]) {
    const sessionId = parts[4] as string;

    if (parts.length === 5) {
      if (req.method !== 'GET') return null;
      const repoDb = openRepoDb(repoDbPath(repo.root));
      try {
        const detail = getSessionDetail(repoDb, sessionId);
        if (!detail) return notFound(`no such session: ${sessionId}`);
        return Response.json(detail);
      } finally {
        repoDb.close();
      }
    }

    if (parts[5] === 'events' && parts.length === 6) {
      if (req.method !== 'GET') return null;
      const repoDb = openRepoDb(repoDbPath(repo.root));
      try {
        const fromSeq = url.searchParams.has('from')
          ? Number(url.searchParams.get('from'))
          : undefined;
        const limit = url.searchParams.has('limit')
          ? Number(url.searchParams.get('limit'))
          : undefined;
        const filter = (url.searchParams.get('filter') as TimelineFilter | null) ?? undefined;
        return Response.json(
          getTimelinePage(repoDb, sessionId, {
            ...(fromSeq !== undefined && !Number.isNaN(fromSeq) && { fromSeq }),
            ...(limit !== undefined && !Number.isNaN(limit) && { limit }),
            ...(filter && { filter }),
          }),
        );
      } finally {
        repoDb.close();
      }
    }

    if (parts[5] === 'events' && parts[6] && parts.length === 7) {
      if (req.method !== 'GET') return null;
      const seq = Number(parts[6]);
      if (Number.isNaN(seq)) return badRequest('seq must be a number');
      const repoDb = openRepoDb(repoDbPath(repo.root));
      try {
        const [event] = repoDb.getEvents(sessionId, { from: seq, to: seq });
        if (!event) return notFound(`no event ${seq} in session ${sessionId}`);
        return Response.json(event);
      } finally {
        repoDb.close();
      }
    }

    if (parts[5] === 'evidence' && parts.length === 6) {
      if (req.method !== 'GET') return null;
      const findingId = url.searchParams.get('findingId');
      if (!findingId) return badRequest('findingId query param required');
      const repoDb = openRepoDb(repoDbPath(repo.root));
      try {
        const finding = repoDb.getFinding(findingId);
        if (!finding || finding.sessionId !== sessionId) {
          return notFound(`no such finding: ${findingId}`);
        }
        return Response.json({ events: getEvidenceForFinding(repoDb, finding) });
      } finally {
        repoDb.close();
      }
    }
  }

  // /api/repos/:id/commits/:sha
  if (parts[3] === 'commits' && parts[4] && parts.length === 5) {
    if (req.method !== 'GET') return null;
    const commit = getCommitDetail(repo.root, parts[4] as string);
    if (!commit) return notFound(`no such commit: ${parts[4]}`);
    return Response.json(commit);
  }

  // /api/repos/:id/findings/:fid/resolve
  if (parts[3] === 'findings' && parts[4] && parts[5] === 'resolve' && parts.length === 6) {
    if (req.method !== 'POST') return null;
    const repoDb = openRepoDb(repoDbPath(repo.root));
    try {
      const finding = resolveFindingMutation(repoDb, ctx.registryDb, repoId, parts[4] as string);
      if (!finding) return notFound(`no such finding: ${parts[4]}`);
      ctx.bus.publish({ type: 'session_updated', repoId, sessionId: finding.sessionId });
      ctx.bus.publish({ type: 'repo_updated', repoId });
      logger.info('resolved finding via /api', { repoId, findingId: finding.id });
      return Response.json(finding);
    } finally {
      repoDb.close();
    }
  }

  // /api/repos/:id/findings/:fid/brief — POST pins, DELETE unpins ("add to brief" / remove, 05-UI.md §2.3)
  if (
    parts[3] === 'findings' &&
    parts[4] &&
    parts[5] === 'brief' &&
    parts.length === 6 &&
    (req.method === 'POST' || req.method === 'DELETE')
  ) {
    const pinned = req.method === 'POST';
    const repoDb = openRepoDb(repoDbPath(repo.root));
    try {
      const finding = await setFindingPinnedMutation(
        repoDb,
        repo.root,
        parts[4] as string,
        pinned,
        logger,
      );
      if (!finding) return notFound(`no such finding: ${parts[4]}`);
      ctx.bus.publish({ type: 'session_updated', repoId, sessionId: finding.sessionId });
      ctx.bus.publish({ type: 'repo_updated', repoId });
      logger.info(`${pinned ? 'pinned' : 'unpinned'} finding via /api`, {
        repoId,
        findingId: finding.id,
      });
      return Response.json(finding);
    } finally {
      repoDb.close();
    }
  }

  return null;
}
