import { z } from 'zod';

/** Which agent backend the API serves chat from (`CHAT_BACKEND` on the API). */
export const ChatBackendSchema = z.enum(['inkeep', 'parlant']);
export type ChatBackend = z.infer<typeof ChatBackendSchema>;
export const DEFAULT_CHAT_BACKEND: ChatBackend = 'inkeep';

/** Response of `GET /api/config`: what the web app needs to know at startup. */
export const AppConfigSchema = z.object({ chatBackend: ChatBackendSchema });
export type AppConfig = z.infer<typeof AppConfigSchema>;

/** Reads `CHAT_BACKEND`, falling back to Inkeep when unset; throws on typos. */
export function chatBackend(
  env: Record<string, string | undefined>,
): ChatBackend {
  return ChatBackendSchema.parse(env.CHAT_BACKEND || DEFAULT_CHAT_BACKEND);
}
