import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

// M3 (05-UI.md §4.2/§4.3) — subscribes once to the daemon's SSE stream and
// invalidates TanStack Query's cache by repo/session id on each event,
// rather than every screen opening its own EventSource. Same-origin, so
// the bootstrap cookie is sent automatically.

type SseEvent =
  | { type: 'repo_updated'; repoId: string }
  | { type: 'session_updated'; repoId: string; sessionId: string }
  | { type: 'finding_added'; repoId: string; sessionId: string; findingId: string }
  | { type: 'heartbeat' };

export function useLiveUpdates(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onmessage = (msg) => {
      let event: SseEvent;
      try {
        event = JSON.parse(msg.data) as SseEvent;
      } catch {
        return;
      }
      switch (event.type) {
        case 'repo_updated':
          queryClient.invalidateQueries({ queryKey: ['repos'] });
          queryClient.invalidateQueries({ queryKey: ['repo', event.repoId] });
          break;
        case 'session_updated':
        case 'finding_added':
          queryClient.invalidateQueries({ queryKey: ['repos'] });
          queryClient.invalidateQueries({ queryKey: ['repo', event.repoId] });
          queryClient.invalidateQueries({
            queryKey: ['session', event.repoId, event.sessionId],
          });
          break;
        case 'heartbeat':
          break;
      }
    };
    return () => source.close();
  }, [queryClient]);
}
