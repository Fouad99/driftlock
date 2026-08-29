import type { Decision } from '../schema/decision.ts';
import type { Event } from '../schema/event.ts';
import type { Finding, NewFinding } from '../schema/finding.ts';
import type { Session } from '../schema/session.ts';
import type { Task } from '../schema/task.ts';
import type { GitContext } from './git-context.ts';
import type { Judge } from './judge.ts';

// Architecture doc §6.1 — Analyzer contract. Pure function: deterministic
// analyzers have no I/O beyond these inputs.

export interface AnalyzerNeeds {
  decisions?: boolean;
  task?: boolean;
  git?: boolean;
  judge?: boolean;
}

export interface AnalyzerInput {
  session: Session;
  events: Event[]; // ordered by seq
  task?: Task;
  decisions?: Decision[];
  git?: GitContext;
  judge?: Judge;
  previousFindings: Finding[]; // unresolved findings from earlier sessions in this repo
}

export interface Analyzer {
  id: string;
  needs: AnalyzerNeeds;
  run(input: AnalyzerInput): Promise<NewFinding[]>;
}
