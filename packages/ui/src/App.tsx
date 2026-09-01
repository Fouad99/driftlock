import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { useLiveUpdates } from './hooks/useLiveUpdates.ts';
import { Overview } from './screens/Overview.tsx';
import { SessionScreen } from './screens/Session.tsx';

const queryClient = new QueryClient();

function Routed() {
  useLiveUpdates();
  return (
    <Routes>
      <Route path="/" element={<Overview />} />
      <Route path="/repo/:repoId/session/:sessionId" element={<SessionScreen />} />
    </Routes>
  );
}

// 05-UI.md §5 — M3 (UI-1) ships Overview + Session only; Project (UI-2) and
// Trends (UI-3) routes land in later milestones.
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routed />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
