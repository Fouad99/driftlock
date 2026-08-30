import type { NewEvent } from '@driftlock/core';
import { parseEventPayload } from '@driftlock/core';
import { parseApplyPatch } from './apply-patch.ts';
import { inferExitCode, isTestCommand } from './test-detect.ts';

// M1′ §B4 — PostToolUse event mapping for Codex's local function tools
// (`apply_patch`, `Bash`, `update_plan` — canonical `tool_name` values per
// codex-rs/core/src/tools/hook_names.rs, not the docs' matcher aliases)
// plus a generic fallback.
// `tool_response`'s contents aren't documented beyond "exit code, output",
// so extraction is defensive with a raw-string fallback — same convention
// as the Claude Code adapter's tool-mapping.ts.

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function extractOutputText(toolResponse: unknown): string {
  if (typeof toolResponse === 'string') return toolResponse;
  const o = record(toolResponse);
  for (const key of ['output', 'stdout', 'text', 'content', 'result']) {
    const v = str(o[key]);
    if (v !== undefined) return v;
  }
  return JSON.stringify(toolResponse ?? null);
}

function extractExitCode(toolResponse: unknown, outputText: string): number {
  const o = record(toolResponse);
  if (typeof o.exit_code === 'number') return o.exit_code;
  if (typeof o.exitCode === 'number') return o.exitCode;
  return inferExitCode(outputText);
}

function mapApplyPatch(
  toolInput: unknown,
  toolResponse: unknown,
  callId: string,
  ts: number,
  sessionId: string,
): NewEvent[] {
  const command = str(record(toolInput).command) ?? '';
  const edits = parseApplyPatch(command);
  const outputText = extractOutputText(toolResponse);
  const ok = extractExitCode(toolResponse, outputText) === 0;

  const events: NewEvent[] = [
    {
      sessionId,
      ts,
      ...parseEventPayload('tool_call', { callId, name: 'apply_patch', args: { command } }),
    } as NewEvent,
  ];
  for (const edit of edits) {
    events.push({
      sessionId,
      ts,
      ...parseEventPayload('file_edit', { path: edit.path, hunks: edit.hunks, callId }),
    } as NewEvent);
  }
  events.push({
    sessionId,
    ts,
    ...parseEventPayload('tool_result', { callId, ok, output: outputText }),
  } as NewEvent);
  return events;
}

// The hook payload's `tool_name` for shell/exec_command calls is literally
// "Bash" — verified against codex-rs/core/src/tools/hook_names.rs's
// `HookToolName::bash()`, whose canonical `name` is `"Bash"` with no
// matcher aliases (unlike `apply_patch`, whose payload name really is
// "apply_patch" despite `Edit`/`Write` being additional *matcher* aliases
// that never appear in the payload itself). Not "shell" — that was wrong in
// an earlier pass here, confused with Codex's transcript-format function
// name (a separate, unrelated serialization `parseTranscript` reads).
function mapBash(
  toolInput: unknown,
  toolResponse: unknown,
  callId: string,
  ts: number,
  sessionId: string,
): NewEvent[] {
  const command = str(record(toolInput).command) ?? '';
  const outputText = extractOutputText(toolResponse);
  const exitCode = extractExitCode(toolResponse, outputText);

  if (isTestCommand(command)) {
    return [
      {
        sessionId,
        ts,
        ...parseEventPayload('test_run', { command, exitCode, summary: outputText, callId }),
      } as NewEvent,
    ];
  }

  return [
    {
      sessionId,
      ts,
      ...parseEventPayload('tool_call', { callId, name: 'Bash', args: { command } }),
    } as NewEvent,
    {
      sessionId,
      ts,
      ...parseEventPayload('tool_result', { callId, ok: exitCode === 0, output: outputText }),
    } as NewEvent,
  ];
}

/**
 * Maps `update_plan`'s `{ plan: [{ step, status }], explanation? }` input to
 * one `plan_item` per step. Steps carry no stable id of their own (Codex
 * resends the whole plan on every call, same as Claude Code's `TodoWrite`),
 * so list position is used as the closest available identity.
 */
function mapUpdatePlan(toolInput: unknown, ts: number, sessionId: string): NewEvent[] {
  const steps = record(toolInput).plan;
  if (!Array.isArray(steps)) return [];
  const events: NewEvent[] = [];
  steps.forEach((s, i) => {
    const step = record(s);
    const text = str(step.step);
    const status = str(step.status);
    if (text === undefined || status === undefined) return;
    events.push({
      sessionId,
      ts,
      ...parseEventPayload('plan_item', { id: `plan-${i}`, text, status }),
    } as NewEvent);
  });
  return events;
}

function mapGenericTool(
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
  callId: string,
  ts: number,
  sessionId: string,
): NewEvent[] {
  const outputText = extractOutputText(toolResponse);
  const ok = extractExitCode(toolResponse, outputText) === 0;
  return [
    {
      sessionId,
      ts,
      ...parseEventPayload('tool_call', { callId, name: toolName, args: toolInput }),
    } as NewEvent,
    {
      sessionId,
      ts,
      ...parseEventPayload('tool_result', { callId, ok, output: outputText }),
    } as NewEvent,
  ];
}

/** Maps one Codex PostToolUse hook payload to the events it represents. */
export function mapCodexPostToolUse(
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
  callId: string | undefined,
  ts: number,
  sessionId: string,
): NewEvent[] {
  const id = callId ?? '';
  switch (toolName) {
    case 'apply_patch':
      return mapApplyPatch(toolInput, toolResponse, id, ts, sessionId);
    case 'Bash':
      return mapBash(toolInput, toolResponse, id, ts, sessionId);
    case 'update_plan':
      return mapUpdatePlan(toolInput, ts, sessionId);
    default:
      return mapGenericTool(toolName, toolInput, toolResponse, id, ts, sessionId);
  }
}
