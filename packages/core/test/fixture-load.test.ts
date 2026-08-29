import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AdapterOutput, RepoRef, TranscriptRef } from '../src/interfaces/adapter.ts';
import { parseEventPayload } from '../src/schema/event.ts';
import type { NewEvent } from '../src/schema/event.ts';
import { type RepoStore, openRepoDb } from '../src/store/index.ts';

/**
 * Minimal stand-in for the real claude-code adapter (built in M1). Parses the
 * fixture JSONL just well enough to prove fixture -> events -> store -> read
 * back works end to end, per the M0 exit criterion.
 */
class StubClaudeCodeAdapter implements Adapter {
  readonly agent = 'claude-code' as const;
  readonly capabilities = { resumeInject: true, preEditVerdict: true, liveEvents: true };

  async install(_repo: RepoRef) {
    return { installed: true, details: 'stub adapter, no real install' };
  }

  async *parseTranscript(
    file: TranscriptRef,
    _ctx: { repo: RepoRef },
  ): AsyncIterable<AdapterOutput> {
    const lines = readFileSync(file.path, 'utf-8').trim().split('\n');
    const sessionId = 'fixture-session';
    let seq = 0;
    const startedAt = Date.now();

    yield {
      kind: 'session_start',
      session: {
        id: sessionId,
        agent: 'claude-code',
        agentSession: 'sess_c1',
        repoRoot: file.repoRoot,
        branch: null,
        headBefore: null,
        headAfter: null,
        startedAt,
        taskText: null,
        tokenIn: null,
        tokenOut: null,
        costUsd: null,
        source: 'transcript',
      },
    };

    const events: NewEvent[] = [];
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      const ts = record.timestamp ? Date.parse(record.timestamp as string) : Date.now();
      seq += 1;

      if (record.type === 'user') {
        const message = record.message as { content: string };
        const { kind, payload } = parseEventPayload('user_turn', { text: message.content });
        events.push({ sessionId, ts, kind, payload } as NewEvent);
      } else if (record.type === 'assistant') {
        const message = record.message as { content: Array<Record<string, unknown>> };
        const textBlock = message.content.find((c) => c.type === 'text');
        if (textBlock) {
          const { kind, payload } = parseEventPayload('agent_turn', { text: textBlock.text });
          events.push({ sessionId, ts, kind, payload } as NewEvent);
        }
        const toolUse = message.content.find((c) => c.type === 'tool_use');
        if (toolUse) {
          const { kind, payload } = parseEventPayload('tool_call', {
            callId: toolUse.id,
            name: toolUse.name,
            args: toolUse.input,
          });
          events.push({ sessionId, ts, kind, payload } as NewEvent);
        }
      } else if (record.type === 'system' && record.subtype === 'compact_boundary') {
        const meta = record.compactMetadata as { tokensBefore: number; tokensAfter: number };
        const { kind, payload } = parseEventPayload('compaction', {
          tokensBefore: meta.tokensBefore,
          tokensAfter: meta.tokensAfter,
        });
        events.push({ sessionId, ts, kind, payload } as NewEvent);
      }
    }

    yield { kind: 'events', sessionId, events };
    yield { kind: 'session_end', sessionId, reason: 'stop' };
  }
}

let dir: string;
let repoDb: RepoStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driftlock-fixture-test-'));
  repoDb = openRepoDb(join(dir, 'repo.sqlite'));
});

afterEach(() => {
  repoDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('fixture -> stub adapter -> store -> read back', () => {
  test('loads the claude-code fixture and reads events back in order', async () => {
    const adapter = new StubClaudeCodeAdapter();
    const fixturePath = join(
      import.meta.dir,
      '..',
      '..',
      '..',
      'fixtures',
      'claude-code',
      'session-1.jsonl',
    );
    const repo: RepoRef = { root: '/repo', repoId: 'repo-1' };
    if (!adapter.parseTranscript) throw new Error('stub adapter must implement parseTranscript');

    let sessionId: string | undefined;
    for await (const output of adapter.parseTranscript(
      { path: fixturePath, repoRoot: repo.root },
      { repo },
    )) {
      if (output.kind === 'session_start') {
        const session = repoDb.createSession(output.session);
        sessionId = session.id;
      } else if (output.kind === 'events') {
        expect(sessionId).toBeDefined();
        repoDb.appendEvents(sessionId as string, output.events);
      } else if (output.kind === 'session_end') {
        repoDb.endSession(sessionId as string, Date.now(), output.reason);
      }
    }

    expect(sessionId).toBeDefined();
    const events = repoDb.getEvents(sessionId as string);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('user_turn');
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('compaction');

    const session = repoDb.getSession(sessionId as string);
    expect(session?.endReason).toBe('stop');
    expect(session?.endedAt).not.toBeNull();
  });
});
