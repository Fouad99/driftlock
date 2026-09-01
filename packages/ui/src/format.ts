export function formatRelativeTime(ts: number | null): string {
  if (ts === null) return 'never';
  const diffMs = Date.now() - ts;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function formatDuration(startedAt: number, endedAt: number | null): string {
  if (endedAt === null) return 'in progress';
  const minutes = Math.round((endedAt - startedAt) / 60000);
  return `${minutes} min`;
}
