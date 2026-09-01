import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { getRepos } from '../api.ts';
import { Sparkline } from '../components/Sparkline.tsx';
import { formatRelativeTime } from '../format.ts';

const GIT_STATUS_LABEL: Record<string, string> = {
  clean: 'clean',
  dirty: 'dirty',
  unavailable: '—',
};

// 05-UI.md §2.1 — Overview: one row per registered repo, purely from the
// denormalized `/api/repos` response (no per-row extra fetch, no git probe
// from here — that's the daemon's job, cached). M3: click row → its latest
// session (Project, the eventual destination, is UI-2).
export function Overview() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ['repos'],
    queryFn: getRepos,
  });

  if (isLoading) return <p className="p-6 text-sm text-neutral-500">Loading…</p>;
  if (error) return <p className="p-6 text-sm text-red-600">{(error as Error).message}</p>;

  const repos = data?.repos ?? [];

  if (repos.length === 0) {
    return (
      <p className="p-6 text-sm text-neutral-500">
        No repos registered yet — run{' '}
        <code className="rounded bg-neutral-200 px-1 dark:bg-neutral-800">driftlock init</code> in a
        repo.
      </p>
    );
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-semibold">Repos</h1>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-neutral-500 dark:border-neutral-800">
            <th className="py-2 pr-4 font-medium">Repo</th>
            <th className="py-2 pr-4 font-medium">Last session</th>
            <th className="py-2 pr-4 font-medium">Open findings</th>
            <th className="py-2 pr-4 font-medium">Branch</th>
            <th className="py-2 pr-4 font-medium">14-day findings</th>
          </tr>
        </thead>
        <tbody>
          {repos.map((repo) => {
            const clickable = repo.latestSessionId !== null;
            const goToLatestSession = () => {
              if (repo.latestSessionId) {
                navigate(`/repo/${repo.repoId}/session/${repo.latestSessionId}`);
              }
            };
            return (
              <tr
                key={repo.repoId}
                onClick={goToLatestSession}
                onKeyDown={(e) => {
                  if (clickable && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    goToLatestSession();
                  }
                }}
                tabIndex={clickable ? 0 : undefined}
                role={clickable ? 'button' : undefined}
                className={`border-b border-neutral-100 dark:border-neutral-900 ${
                  clickable
                    ? 'cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-900'
                    : 'opacity-60'
                }`}
              >
                <td className="py-2 pr-4">
                  <div className="font-medium">{repo.name ?? repo.root}</div>
                  <div className="text-xs text-neutral-500">{repo.root}</div>
                </td>
                <td className="py-2 pr-4">
                  {formatRelativeTime(repo.latestSessionAt)}
                  {repo.latestSessionAgent && (
                    <span className="ml-1 text-xs text-neutral-500">
                      ({repo.latestSessionAgent})
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4">
                  <div className="flex gap-2">
                    {repo.openFindings.high > 0 && (
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                        {repo.openFindings.high} high
                      </span>
                    )}
                    {repo.openFindings.warn > 0 && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                        {repo.openFindings.warn} warn
                      </span>
                    )}
                    {repo.openFindings.info > 0 && (
                      <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                        {repo.openFindings.info} info
                      </span>
                    )}
                    {repo.openFindings.high === 0 &&
                      repo.openFindings.warn === 0 &&
                      repo.openFindings.info === 0 && (
                        <span className="text-neutral-400">none</span>
                      )}
                  </div>
                </td>
                <td className="py-2 pr-4">
                  {repo.branch ?? '—'}{' '}
                  <span className="text-xs text-neutral-500">
                    ({GIT_STATUS_LABEL[repo.gitStatus] ?? repo.gitStatus})
                  </span>
                </td>
                <td className="py-2 pr-4">
                  <Sparkline points={repo.findingSparkline} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
