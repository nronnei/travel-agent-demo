import { useChat } from '@ai-sdk/react';
import { CONVERSATION_KEY_HEADER } from '@travel-agent/shared';
import { DefaultChatTransport } from 'ai';
import { useMemo } from 'react';
import type { ChatEngine } from './engine';
import { fromAiSdkParts } from './searchActivity';

// The Nest API proxies this to the Inkeep run API, adding auth server-side.
// Inkeep keeps its own history and reads only the newest user message, and the
// scripted intake messages exist only in this browser, so send just the new turn.
// Per-request headers (the conversation key) and body (`brief`) pass through.
const transport = new DefaultChatTransport({
  api: '/api/chat',
  prepareSendMessagesRequest: ({ id, messages, body }) => ({
    body: { ...body, id, messages: messages.slice(-1) },
  }),
});

/**
 * Inkeep, through `POST /api/chat`: replies stream back as the AI SDK UI message
 * stream, with widgets as `data-component` parts. An edited brief rides along
 * with the next turn, and the API prepends a note about it for the agent.
 */
export function useAiSdkEngine(): ChatEngine {
  const {
    id,
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    error,
    clearError,
  } = useChat({ transport });
  // Web search shows as a `data-search` part derived from the search tool parts.
  // Only the last message can still be streaming; once the stream finishes,
  // errors or is stopped, anything still searching settles.
  const withSearch = useMemo(() => {
    const live = status === 'submitted' || status === 'streaming';
    return messages.map((m, i) =>
      fromAiSdkParts(m, !(live && i === messages.length - 1)),
    );
  }, [messages, status]);
  return {
    id,
    messages: withSearch,
    setMessages,
    status,
    typing: false,
    error,
    clearError,
    send(text, { key, brief }) {
      void sendMessage(
        { text },
        {
          headers: key ? { [CONVERSATION_KEY_HEADER]: key } : undefined,
          body: brief ? { brief } : undefined,
        },
      );
    },
    stop: () => void stop(),
  };
}
