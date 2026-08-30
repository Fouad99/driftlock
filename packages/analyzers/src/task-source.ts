import type { RepoStore, Session, Task, TaskSource } from '@driftlock/core';
import { deriveTask } from './derive-task.ts';

/**
 * v1 `TaskSource` (architecture doc §4.4) — transcript-derived only; issue
 * trackers (Beads, GitHub Issues) are later plugins (backlog).
 *
 * `next()` doesn't have a "next" in any real sense yet without an external
 * tracker: it reports the most recent session's own `current()` task, so a
 * plugin-free repo's resume brief still has something to say about what was
 * in flight. Once a plugin `TaskSource` exists, `next()` is where it would
 * diverge — e.g. the next ready issue, rather than a replay of the last one.
 */
export class TranscriptTaskSource implements TaskSource {
  constructor(private readonly repoDb: RepoStore) {}

  async current(session: Session): Promise<Task | null> {
    const events = this.repoDb.getEvents(session.id);
    return deriveTask(session, events) ?? null;
  }

  async next(_repoRoot: string): Promise<Task | null> {
    const [latest] = this.repoDb.listSessions({ limit: 1 });
    if (!latest) return null;
    return this.current(latest);
  }
}
