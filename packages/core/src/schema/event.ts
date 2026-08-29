import { z } from 'zod';

// Payload shapes per event kind — architecture doc §5.2.
// Unknown agent events are never dropped: adapters fall back to `raw`.

export const HunkSchema = z.object({
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  text: z.string(),
});
export type Hunk = z.infer<typeof HunkSchema>;

export const UserTurnPayload = z.object({
  text: z.string(),
});

export const AgentTurnPayload = z.object({
  text: z.string(),
  reasoning: z.string().optional(),
});

export const ToolCallPayload = z.object({
  callId: z.string(),
  name: z.string(),
  args: z.unknown(),
});

export const ToolResultPayload = z.object({
  callId: z.string(),
  ok: z.boolean(),
  output: z.string(),
  durationMs: z.number().optional(),
});

export const FileEditPayload = z.object({
  path: z.string(),
  hunks: z.array(HunkSchema),
  callId: z.string().optional(),
});

export const FileReadPayload = z.object({
  path: z.string(),
  range: z.tuple([z.number().int(), z.number().int()]).optional(),
});

export const TestRunPayload = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  summary: z.string().optional(),
  callId: z.string().optional(),
});

export const CompactionPayload = z.object({
  tokensBefore: z.number().optional(),
  tokensAfter: z.number().optional(),
});

export const PermissionPayload = z.object({
  tool: z.string(),
  args: z.unknown(),
  decision: z.enum(['allow', 'deny', 'ask']),
});

export const SubagentPayload = z.object({
  id: z.string(),
  parentSeq: z.number().int(),
  task: z.string(),
});

export const PlanItemPayload = z.object({
  id: z.string(),
  text: z.string(),
  status: z.string(),
});

export const SessionEndPayload = z.object({
  reason: z.string(),
});

// Escape hatch: agent emits something the adapter doesn't recognize yet.
// Nothing is ever lost — see architecture doc §5.2 rules and §10 failure modes.
export const RawPayload = z.object({
  originalKind: z.string(),
  data: z.unknown(),
});

export const EventPayloadByKind = {
  user_turn: UserTurnPayload,
  agent_turn: AgentTurnPayload,
  tool_call: ToolCallPayload,
  tool_result: ToolResultPayload,
  file_edit: FileEditPayload,
  file_read: FileReadPayload,
  test_run: TestRunPayload,
  compaction: CompactionPayload,
  permission: PermissionPayload,
  subagent: SubagentPayload,
  plan_item: PlanItemPayload,
  session_end: SessionEndPayload,
  raw: RawPayload,
} as const;

export type EventKind = keyof typeof EventPayloadByKind;

export const EVENT_KINDS = Object.keys(EventPayloadByKind) as EventKind[];

export const EventSchema = z.discriminatedUnion('kind', [
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int(),
    kind: z.literal('user_turn'),
    payload: UserTurnPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int(),
    kind: z.literal('agent_turn'),
    payload: AgentTurnPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int(),
    kind: z.literal('tool_call'),
    payload: ToolCallPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int(),
    kind: z.literal('tool_result'),
    payload: ToolResultPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int(),
    kind: z.literal('file_edit'),
    payload: FileEditPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int(),
    kind: z.literal('file_read'),
    payload: FileReadPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int(),
    kind: z.literal('test_run'),
    payload: TestRunPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int(),
    kind: z.literal('compaction'),
    payload: CompactionPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int(),
    kind: z.literal('permission'),
    payload: PermissionPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int(),
    kind: z.literal('subagent'),
    payload: SubagentPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int(),
    kind: z.literal('plan_item'),
    payload: PlanItemPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int(),
    kind: z.literal('session_end'),
    payload: SessionEndPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int(),
    kind: z.literal('raw'),
    payload: RawPayload,
  }),
]);
export type Event = z.infer<typeof EventSchema>;

// Shape used before a `seq` is assigned by the store writer.
export const NewEventSchema = z.discriminatedUnion('kind', [
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative().optional(),
    ts: z.number().int(),
    kind: z.literal('user_turn'),
    payload: UserTurnPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative().optional(),
    ts: z.number().int(),
    kind: z.literal('agent_turn'),
    payload: AgentTurnPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative().optional(),
    ts: z.number().int(),
    kind: z.literal('tool_call'),
    payload: ToolCallPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative().optional(),
    ts: z.number().int(),
    kind: z.literal('tool_result'),
    payload: ToolResultPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative().optional(),
    ts: z.number().int(),
    kind: z.literal('file_edit'),
    payload: FileEditPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative().optional(),
    ts: z.number().int(),
    kind: z.literal('file_read'),
    payload: FileReadPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative().optional(),
    ts: z.number().int(),
    kind: z.literal('test_run'),
    payload: TestRunPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative().optional(),
    ts: z.number().int(),
    kind: z.literal('compaction'),
    payload: CompactionPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative().optional(),
    ts: z.number().int(),
    kind: z.literal('permission'),
    payload: PermissionPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative().optional(),
    ts: z.number().int(),
    kind: z.literal('subagent'),
    payload: SubagentPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative().optional(),
    ts: z.number().int(),
    kind: z.literal('plan_item'),
    payload: PlanItemPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative().optional(),
    ts: z.number().int(),
    kind: z.literal('session_end'),
    payload: SessionEndPayload,
  }),
  z.object({
    sessionId: z.string(),
    seq: z.number().int().nonnegative().optional(),
    ts: z.number().int(),
    kind: z.literal('raw'),
    payload: RawPayload,
  }),
]);
export type NewEvent = z.infer<typeof NewEventSchema>;

export function parseEventPayload(
  kind: string,
  payload: unknown,
): { kind: EventKind; payload: unknown } {
  if (kind in EventPayloadByKind) {
    const schema = EventPayloadByKind[kind as EventKind];
    const result = schema.safeParse(payload);
    if (result.success) {
      return { kind: kind as EventKind, payload: result.data };
    }
  }
  return {
    kind: 'raw',
    payload: { originalKind: kind, data: payload } satisfies z.infer<typeof RawPayload>,
  };
}
