import { z } from 'zod';

// Field shapes per M1′ implementation plan §B4 (verified against
// https://developers.openai.com/codex/hooks at plan-update time). Per-tool
// `tool_input`/`tool_response` shapes are not documented beyond `.command`
// for apply_patch/shell, so extraction is defensive in hook-tool-mapping.ts —
// same convention as the Claude Code adapter's tool-mapping.ts.

const CommonFields = {
  session_id: z.string(),
  cwd: z.string(),
};

export const SessionStartPayload = z.object({
  ...CommonFields,
  hook_event_name: z.literal('SessionStart'),
  source: z.enum(['startup', 'resume', 'clear', 'compact']).optional(),
  model: z.string().optional(),
});

export const UserPromptSubmitPayload = z.object({
  ...CommonFields,
  hook_event_name: z.literal('UserPromptSubmit'),
  prompt: z.string(),
  turn_id: z.string().optional(),
});

export const PostToolUsePayload = z.object({
  ...CommonFields,
  hook_event_name: z.literal('PostToolUse'),
  tool_name: z.string(),
  tool_use_id: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
});

export const PermissionRequestPayload = z.object({
  ...CommonFields,
  hook_event_name: z.literal('PermissionRequest'),
  tool_name: z.string(),
  tool_input: z.unknown().optional(),
});

export const PostCompactPayload = z.object({
  ...CommonFields,
  hook_event_name: z.literal('PostCompact'),
  trigger: z.enum(['manual', 'auto']).optional(),
});

export const StopPayload = z.object({
  ...CommonFields,
  hook_event_name: z.literal('Stop'),
  last_assistant_message: z.string().optional(),
  turn_id: z.string().optional(),
});

export const SessionEndPayload = z.object({
  ...CommonFields,
  hook_event_name: z.literal('SessionEnd'),
  reason: z.string().optional(),
});
