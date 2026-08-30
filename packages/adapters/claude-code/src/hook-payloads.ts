import { z } from 'zod';

// Field shapes verified against https://code.claude.com/docs/en/hooks
// (fetched at implementation time, per implementation plan A-08/M1 step 7).
// `tool_input`/`tool_output` per-tool shapes (Edit/Write/MultiEdit/Bash) are
// NOT documented there and are handled defensively in tool-mapping.ts — the
// raw value is always preserved even when our parsing guesses wrong.

const CommonFields = {
  session_id: z.string(),
  cwd: z.string(),
};

export const SessionStartPayload = z.object({
  ...CommonFields,
  hook_event_name: z.literal('SessionStart'),
  session_reason: z.enum(['startup', 'resume', 'clear', 'compact', 'fork']).optional(),
});

export const UserPromptSubmitPayload = z.object({
  ...CommonFields,
  hook_event_name: z.literal('UserPromptSubmit'),
  user_prompt: z.string(),
});

export const PostToolUsePayload = z.object({
  ...CommonFields,
  hook_event_name: z.literal('PostToolUse'),
  tool_name: z.string(),
  tool_input: z.unknown(),
  tool_output: z.unknown(),
  tool_use_id: z.string().optional(),
});

export const PreCompactPayload = z.object({
  ...CommonFields,
  hook_event_name: z.literal('PreCompact'),
  trigger: z.enum(['manual', 'auto']).optional(),
});

export const StopPayload = z.object({
  ...CommonFields,
  hook_event_name: z.literal('Stop'),
  last_assistant_message: z.string().optional(),
  transcript_path: z.string().optional(),
});
