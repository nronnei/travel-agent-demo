import { z } from 'zod';

/**
 * The request body `useChat` (Vercel AI SDK) sends. Only the fields the proxy
 * relies on are checked; everything else passes through to Inkeep untouched.
 */
export const ChatRequestSchema = z.looseObject({
  id: z.string().optional(),
  conversationId: z.string().optional(),
  messages: z
    .array(z.looseObject({ role: z.enum(['user', 'assistant', 'system']) }))
    .min(1),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
