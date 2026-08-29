import type { Session } from '../schema/session.ts';
import type { Task } from '../schema/task.ts';

// Architecture doc §4.4 — TaskSource interface. v1 ships TranscriptTaskSource
// (packages/analyzers or packages/daemon); issue trackers are later plugins.

export interface TaskSource {
  current(session: Session): Promise<Task | null>;
  next(repoRoot: string): Promise<Task | null>;
}
