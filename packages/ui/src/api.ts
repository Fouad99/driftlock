import type {
  CommitDetail,
  Event,
  EventPage,
  EventSummary,
  Finding,
  RepoRow,
  Session,
} from '@driftlock/core';

// M3 (05-UI.md §4.2) — thin fetch client for the daemon's `/api/*`. Every
// request is same-origin (the daemon serves this app's own built assets),
// so the session cookie set by the bootstrap flow (05-UI.md §3) is sent
// automatically — no token handling needed here at all.

export interface RepoBrief {
  sessionId: string;
  generatedAt: number;
  markdown: string;
}

export interface RepoDetail {
  repo: { repoId: string; root: string; name: string | null };
  sessions: Session[];
  brief: RepoBrief | null;
}

export interface SessionDetail {
  session: Session;
  findings: Finding[];
  linkedCommits: string[];
  compactionCount: number;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { ...init?.headers, accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`${res.status} ${(body as { error?: string }).error ?? res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function getRepos(): Promise<{ repos: RepoRow[] }> {
  return apiFetch('/repos');
}

export function getRepoDetail(repoId: string): Promise<RepoDetail> {
  return apiFetch(`/repos/${repoId}`);
}

export function getSessionDetail(repoId: string, sessionId: string): Promise<SessionDetail> {
  return apiFetch(`/repos/${repoId}/sessions/${sessionId}`);
}

export interface EventPageQuery {
  fromSeq?: number;
  limit?: number;
  filter?: 'all' | 'edits' | 'tests' | 'reads' | 'findings';
}

export function getEventPage(
  repoId: string,
  sessionId: string,
  query: EventPageQuery = {},
): Promise<EventPage> {
  const params = new URLSearchParams();
  if (query.fromSeq !== undefined) params.set('from', String(query.fromSeq));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.filter && query.filter !== 'all') params.set('filter', query.filter);
  const qs = params.toString();
  return apiFetch(`/repos/${repoId}/sessions/${sessionId}/events${qs ? `?${qs}` : ''}`);
}

export function getEvent(repoId: string, sessionId: string, seq: number): Promise<Event> {
  return apiFetch(`/repos/${repoId}/sessions/${sessionId}/events/${seq}`);
}

export function getEvidence(
  repoId: string,
  sessionId: string,
  findingId: string,
): Promise<{ events: EventSummary[] }> {
  return apiFetch(
    `/repos/${repoId}/sessions/${sessionId}/evidence?findingId=${encodeURIComponent(findingId)}`,
  );
}

export function getCommit(repoId: string, sha: string): Promise<CommitDetail> {
  return apiFetch(`/repos/${repoId}/commits/${sha}`);
}

export function resolveFinding(repoId: string, findingId: string): Promise<Finding> {
  return apiFetch(`/repos/${repoId}/findings/${findingId}/resolve`, { method: 'POST' });
}

export function setFindingPinned(
  repoId: string,
  findingId: string,
  pinned: boolean,
): Promise<Finding> {
  return apiFetch(`/repos/${repoId}/findings/${findingId}/brief`, {
    method: pinned ? 'POST' : 'DELETE',
  });
}
