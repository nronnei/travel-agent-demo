import { BaseMessage } from '@langchain/core/messages';

/** Content blocks that never go to the browser (Claude's between-tools notes). */
const HIDDEN_BLOCKS = new Set(['thinking', 'redacted_thinking']);

/**
 * A message in the dict form `@langchain/langgraph-sdk` expects
 * (`{...toDict().data, type}`), not LangChain's `lc` constructor JSON, with
 * thinking blocks removed.
 */
export function messageDict(message: BaseMessage): Record<string, unknown> {
  const { type, data } = message.toDict();
  const content = Array.isArray(data.content)
    ? data.content.filter(
        (b) =>
          !(b && typeof b === 'object' && HIDDEN_BLOCKS.has(String(b.type))),
      )
    : data.content;
  return { ...data, content, type };
}

const isMessage = (value: unknown): value is BaseMessage =>
  BaseMessage.isInstance(value);

/** Replaces messages anywhere in a plain object tree with their dict form. */
function serialise(value: unknown): unknown {
  if (isMessage(value)) return messageDict(value);
  if (Array.isArray(value)) return value.map(serialise);
  if (value && typeof value === 'object' && value.constructor === Object)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, serialise(v)]),
    );
  return value;
}

/** The metadata the SDK reads from a `messages` event; the rest stays server-side. */
function messageMetadata(metadata: unknown) {
  const m = (metadata ?? {}) as Record<string, unknown>;
  return {
    langgraph_node: m.langgraph_node,
    langgraph_step: m.langgraph_step,
    langgraph_checkpoint_ns: m.langgraph_checkpoint_ns,
  };
}

/** One `[mode, chunk]` from `graph.stream()` as an SSE frame. */
export function encodeChunk(mode: string, chunk: unknown): string {
  const data =
    mode === 'messages' && Array.isArray(chunk)
      ? [serialise(chunk[0]), messageMetadata(chunk[1])]
      : serialise(chunk);
  return frame(mode, data);
}

export function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** An SSE comment, so idle proxies keep the stream open. */
export const PING = ': ping\n\n';
