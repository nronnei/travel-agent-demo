import {
  ConversationIdSchema,
  TripBriefPropsSchema,
} from '@travel-agent/shared';
import { z } from 'zod';

/**
 * The request body the web app's `useChat` transport sends: the chat id and the
 * newest guest message only (Inkeep keeps its own history). Strict on purpose:
 * the proxy builds the upstream body itself, so nothing else reaches Inkeep.
 */
export const ChatRequestSchema = z.object({
  id: ConversationIdSchema,
  messages: z
    .array(
      z.object({
        id: z.string().max(128),
        role: z.literal('user'),
        parts: z
          .array(
            z.object({
              type: z.literal('text'),
              text: z.string().trim().min(1).max(4000),
            }),
          )
          .length(1),
      }),
    )
    .length(1),
  /** The brief as the guest edited it in the app, if the agent hasn't seen it yet. */
  brief: TripBriefPropsSchema.optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
