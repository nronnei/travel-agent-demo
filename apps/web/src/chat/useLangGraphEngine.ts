import {
  FetchStreamTransport,
  useStream,
} from '@langchain/langgraph-sdk/react';
import {
  CONVERSATION_KEY_HEADER,
  WEB_SEARCH_EVENT_TYPE,
} from '@travel-agent/shared';
import type { UIMessage } from 'ai';
import { useEffect, useRef, useState } from 'react';
import { saveDraft } from '../components/intakeApi';
import type { ChatEngine } from './engine';
import { mergeGraphMessages, type GraphMessage } from './langgraphMessages';

const newConversationId = () =>
  crypto.randomUUID().replaceAll('-', '').slice(0, 16);

const SEARCHING = 'Searching the web…';

/**
 * LangGraph, natively: each guest turn is one run, streamed back as
 * LangGraph's own run events and read with `useStream` from the LangGraph SDK.
 * A widget answer is sent as a resume command; the API (and the agent server
 * behind it) decides whether the thread is actually paused on a widget. An
 * edited brief is saved to the intake record first, where the agent reads it.
 */
export function useLangGraphEngine(): ChatEngine {
  const [id] = useState(newConversationId);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [error, setError] = useState<Error>();
  const [searching, setSearching] = useState(false);
  // The conversation key arrives with the first send; the transport reads it per request.
  const keyRef = useRef<string>(undefined);
  // Message ids on screen when the current run started, to tell when it starts replying.
  const [before, setBefore] = useState<ReadonlySet<string>>(new Set());

  // The key is read when each request is made, not during render.
  const [transport] = useState(
    // oxlint-disable-next-line react/refs -- the ref is read inside onRequest, at request time
    () =>
      new FetchStreamTransport({
        apiUrl: `/api/langgraph/${encodeURIComponent(id)}/stream`,
        onRequest: (_url, init) => {
          const headers = new Headers(init.headers);
          if (keyRef.current)
            headers.set(CONVERSATION_KEY_HEADER, keyRef.current);
          return { ...init, headers };
        },
      }),
  );

  const stream = useStream({
    transport,
    // A browser-side label only: the API runs the thread minted for this claim.
    threadId: id,
    messagesKey: 'messages',
    // Batch store updates. A reply that follows a tool call arrives in one
    // burst (Anthropic holds it back), and unthrottled, each of its ~200
    // chunks re-rendered synchronously within one task, so React hit
    // "Maximum update depth exceeded" after every search.
    throttle: true,
    onCustomEvent: (data: unknown) => {
      if ((data as { type?: string } | null)?.type === WEB_SEARCH_EVENT_TYPE)
        setSearching(true);
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err : new Error(String(err))),
  } as never) as unknown as {
    values: { messages?: GraphMessage[]; widgets?: Record<string, unknown> };
    isLoading: boolean;
    error: unknown;
    stop: () => void;
    submit: (values: unknown, options?: { command?: unknown }) => Promise<void>;
  };

  // `values` itself is a fresh `{}` until the first event, so depend on its parts.
  const graphMessages = stream.values.messages;
  const widgets = stream.values.widgets;
  const loading = stream.isLoading;
  // Accumulated, not derived: `values` resets to {} when each run starts, and
  // earlier turns must stay on screen until the run's first event brings them back.
  useEffect(() => {
    if (!graphMessages?.length) return;
    // oxlint-disable-next-line react/set-state-in-effect -- syncing from the external stream
    setMessages((current) =>
      mergeGraphMessages(current, graphMessages, widgets, loading),
    );
  }, [graphMessages, widgets, loading]);

  const replying =
    loading &&
    messages.some(
      (m) =>
        m.role === 'assistant' &&
        !before.has(m.id) &&
        m.parts.some((p) => p.type === 'text' && p.text),
    );
  const lastSearch = messages
    .at(-1)
    ?.parts.find((p) => p.type === 'data-search') as
    | { data: { state?: string } }
    | undefined;
  // The custom event says a search started before its tool call is parsed;
  // once the turn's search part exists, it alone says whether one is running.
  const isSearching =
    loading && (lastSearch ? lastSearch.data.state === 'searching' : searching);

  return {
    id,
    messages,
    setMessages,
    status: loading
      ? replying
        ? 'streaming'
        : 'submitted'
      : error
        ? 'error'
        : 'ready',
    typing: false,
    activity: isSearching ? SEARCHING : undefined,
    error,
    clearError: () => setError(undefined),
    send(text, { key, brief, answer }) {
      setBefore(new Set(messages.map((m) => m.id)));
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text }],
        },
      ]);
      keyRef.current = key;
      setError(undefined);
      setSearching(false);
      void (async () => {
        try {
          if (brief) await saveDraft(id, brief, key);
          await (answer
            ? stream.submit(null, { command: { resume: answer } })
            : stream.submit({ messages: [{ type: 'human', content: text }] }));
        } catch (err) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    },
    stop: () => stream.stop(),
  };
}
