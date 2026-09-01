import { useQuery } from '@tanstack/react-query';
import { getCommit } from '../api.ts';

interface CommitModalProps {
  repoId: string;
  sha: string;
  onClose: () => void;
}

// 05-UI.md §2.3 — "linked commits (click → `git show` in a modal)".
export function CommitModal({ repoId, sha, onClose }: CommitModalProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['commit', repoId, sha],
    queryFn: () => getCommit(repoId, sha),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        className="max-h-[80vh] w-full max-w-3xl overflow-auto rounded bg-white p-4 shadow-lg dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-mono text-sm font-medium">{sha}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700"
          >
            close
          </button>
        </div>
        {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
        {error && <p className="text-sm text-red-600">{(error as Error).message}</p>}
        {data && <pre className="whitespace-pre-wrap break-words text-xs">{data.show}</pre>}
      </div>
    </div>
  );
}
