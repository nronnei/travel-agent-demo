import { z } from 'zod';
import { ConversationIdSchema } from './intake.js';

/**
 * The LangGraph backend: the guest's answer to a widget, and the request
 * bodies at both hops (browser → Nest API → LangGraph service).
 */

/** A structured answer to a widget the graph paused on (`interrupt()`). */
export const WidgetAnswerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('interests'),
    labels: z.array(z.string().trim().min(1).max(60)).max(20),
  }),
  z.object({ type: z.literal('confirm') }),
  z.object({
    type: z.literal('reply'),
    text: z.string().trim().min(1).max(4000),
  }),
]);
export type WidgetAnswer = z.infer<typeof WidgetAnswerSchema>;

const GuestInputSchema = z.object({
  messages: z
    .array(
      z.object({
        type: z.literal('human'),
        content: z.string().trim().min(1).max(4000),
      }),
    )
    .length(1),
});

/**
 * What the browser may send to `POST /api/langgraph/:id/stream`: a guest
 * message or a widget answer. The SDK's transport also sends `context`,
 * `config` and the like; z.object strips them, and the API builds the
 * upstream body itself.
 */
export const LangGraphStreamRequestSchema = z.union([
  z.object({ input: GuestInputSchema }),
  z.object({ command: z.object({ resume: WidgetAnswerSchema }) }),
]);
export type LangGraphStreamRequest = z.infer<
  typeof LangGraphStreamRequestSchema
>;

/** The body the API sends to the LangGraph service's `/threads/:id/stream`. */
export const LangGraphRunRequestSchema = z.union([
  z.object({ conversationId: ConversationIdSchema, input: GuestInputSchema }),
  z.object({
    conversationId: ConversationIdSchema,
    command: z.object({ resume: WidgetAnswerSchema }),
  }),
]);
export type LangGraphRunRequest = z.infer<typeof LangGraphRunRequestSchema>;

/** Thread ids are minted by the API per claim: 16 random bytes, base64url. */
export const ThreadIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22}$/, 'Invalid thread id');

/** The LangGraph intake's widget tools; their results are the guest's answers. */
export const LANGGRAPH_WIDGET_TOOLS = [
  'suggest_interests',
  'present_brief',
] as const;

/** A widget tool result that means the widget wasn't shown (the model is asked again). */
export const WIDGET_NOT_SHOWN_PREFIX = 'Not shown';

/** The custom stream event the web search tool emits as it starts. */
export const WEB_SEARCH_EVENT_TYPE = 'web-search';
