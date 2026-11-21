import { CONVERSATION_KEY_HEADER } from '@travel-agent/shared';
import type { UIMessage } from 'ai';
import { useCallback, useEffect, useRef, useState } from 'react';
import { saveDraft } from '../components/intakeApi';
import type { ChatEngine } from './engine';
import {
  ParlantEventSchema,
  applyParlantEvent,
  initialParlantState,
  type ParlantChatState,
  type ParlantEvent,
} from './parlantEvents';
import { readSse } from './sse';

/** Pause before re-opening the event stream after an error (Parlant's own retry hint). */
const RETRY_MS = 3000;

/** The API's 410: Parlant no longer has this conversation, so stop retrying. */
class ConversationGoneError extends Error {}

/** The error for a failed API response, with the API's own message for a 410. */
async function responseError(res: Response, fallback: string) {
  if (res.status !== 410) return new Error(`${fallback} (${res.status})`);
  const body = (await res.json().catch(() => ({}))) as { message?: unknown };
  return new ConversationGoneError(
    typeof body.message === 'string' ? body.message : fallback,
  );
}

const newConversationId = () =>
  crypto.randomUUID().replaceAll('-', '').slice(0, 16);

/**
 * Parlant, natively: the guest's message is posted as a session event, and the
 * reply arrives on the session's event stream, which stays open for the whole
 * conversation. Status events drive the typing indicator, widgets come from
 * tool results, agent messages stream in place, and anything the agent sends
 * later (after `ready`) still shows up. An edited brief is saved to the intake
 * record first, where the agent reads it, rather than described in the message.
 */
export function useParlantEngine(): ChatEngine {
  const [id] = useState(newConversationId);
  const [state, setState] = useState<ParlantChatState>(initialParlantState);
  const [sending, setSending] = useState(false);
  // The offset of the guest's last message: waiting until the stream passes it.
  const [posted, setPosted] = useState(-1);
  const [error, setError] = useState<Error>();
  // The conversation key arrives with the first send; the stream opens then.
  const [key, setKey] = useState<string>();
  // The latest state, for the stream loop to resume from without re-subscribing.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const apply = useCallback((event: ParlantEvent) => {
    setState((current) => applyParlantEvent(current, event));
  }, []);

  const api = useCallback(
    (path: string, init: RequestInit = {}) =>
      fetch(`/api/parlant/${encodeURIComponent(id)}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(key ? { [CONVERSATION_KEY_HEADER]: key } : {}),
          ...init.headers,
        },
      }),
    [id, key],
  );

  /** Reads an SSE response of session events into the chat. */
  const consume = useCallback(
    async (res: Response) => {
      if (!res.ok || !res.body)
        throw await responseError(res, 'Agent events failed');
      await readSse(res.body, ({ data }) => {
        const parsed = ParlantEventSchema.safeParse(JSON.parse(data));
        if (parsed.success) apply(parsed.data);
      });
    },
    [apply],
  );

  // The session's event stream. Parlant closes it after a minute without
  // events, so it is re-opened from the last offset seen, for as long as the
  // chat is open.
  useEffect(() => {
    if (!key) return;
    const abort = new AbortController();
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const from = stateRef.current.offset + 1;
          await consume(
            await api(`/events?min_offset=${from}`, { signal: abort.signal }),
          );
        } catch (err) {
          if (abort.signal.aborted) return;
          setError(err instanceof Error ? err : new Error(String(err)));
          if (err instanceof ConversationGoneError) return;
          await new Promise((r) => setTimeout(r, RETRY_MS));
        }
      }
    })();
    return () => abort.abort();
  }, [key, api, consume]);

  // The event stream sends each event once, when it first appears; a message
  // still streaming is followed on its own stream until it is complete.
  const following = useRef(new Set<string>());
  useEffect(() => {
    for (const eventId of state.streaming) {
      if (following.current.has(eventId)) continue;
      following.current.add(eventId);
      void api(`/events/${encodeURIComponent(eventId)}`)
        .then(consume)
        .catch(() => undefined)
        .finally(() => following.current.delete(eventId));
    }
  }, [state.streaming, api, consume]);

  const setMessages = useCallback(
    (update: (current: UIMessage[]) => UIMessage[]) =>
      setState((current) => ({
        ...current,
        messages: update(current.messages),
      })),
    [],
  );

  const waiting = sending || state.offset < posted;
  const status: ChatEngine['status'] =
    waiting || (state.busy && !state.streaming.length)
      ? 'submitted'
      : state.streaming.length
        ? 'streaming'
        : 'ready';

  return {
    id,
    messages: state.messages,
    setMessages,
    status,
    typing: state.typing,
    activity: state.activity,
    error,
    clearError: () => setError(undefined),
    send(text, { key: sendKey, brief }) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text }],
        },
      ]);
      setSending(true);
      setError(undefined);
      if (sendKey !== key) setKey(sendKey);
      void (async () => {
        try {
          if (brief) await saveDraft(id, brief, sendKey);
          const res = await fetch(
            `/api/parlant/${encodeURIComponent(id)}/messages`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(sendKey ? { [CONVERSATION_KEY_HEADER]: sendKey } : {}),
              },
              body: JSON.stringify({ text }),
            },
          );
          if (!res.ok)
            throw await responseError(res, "Couldn't send your message");
          // Waiting until the stream reaches this message; its status events take over.
          setPosted(((await res.json()) as { offset: number }).offset);
        } catch (err) {
          setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
          setSending(false);
        }
      })();
    },
    stop(stopKey) {
      void fetch(`/api/parlant/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        headers: stopKey ? { [CONVERSATION_KEY_HEADER]: stopKey } : {},
      });
    },
  };
}
