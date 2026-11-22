import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';

export const CANCELLED_RESULT =
  'Cancelled: the guest stopped this before it finished.';

/**
 * The history as Anthropic requires it: every tool call answered, with all of
 * its results directly after the AI message that made it and before anything
 * else. A Stop during a search (or an abort before a widget paused) leaves a
 * call without a result, and the guest's next message is already appended by
 * then, so the missing result is inserted here, at the model boundary, rather
 * than appended to state.
 *
 * AI messages are passed through untouched, so any thinking blocks (and their
 * signatures) stay valid. Results that turn up out of place are dropped.
 */
export function repairHistory(messages: readonly BaseMessage[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    // Results directly after their AI message are consumed below; any other is out of place.
    if (ToolMessage.isInstance(message)) continue;
    out.push(message);
    if (!AIMessage.isInstance(message) || !message.tool_calls?.length) continue;
    const ids = message.tool_calls.map((c) => c.id).filter(Boolean) as string[];
    const answered = new Set<string>();
    while (i + 1 < messages.length && ToolMessage.isInstance(messages[i + 1])) {
      const result = messages[++i] as ToolMessage;
      if (
        ids.includes(result.tool_call_id) &&
        !answered.has(result.tool_call_id)
      ) {
        out.push(result);
        answered.add(result.tool_call_id);
      }
    }
    for (const call of message.tool_calls) {
      if (!call.id || answered.has(call.id)) continue;
      out.push(
        new ToolMessage({
          tool_call_id: call.id,
          name: call.name,
          content: CANCELLED_RESULT,
        }),
      );
    }
  }
  return out;
}

/** Tool call ids in `messages` that have no result anywhere after them. */
export function unansweredToolCalls(messages: readonly BaseMessage[]) {
  const answered = new Set(
    messages
      .filter((m) => ToolMessage.isInstance(m))
      .map((m) => m.tool_call_id),
  );
  return messages
    .filter((m) => AIMessage.isInstance(m))
    .flatMap((m) => m.tool_calls ?? [])
    .filter((c) => c.id && !answered.has(c.id));
}

/**
 * The planner's view of the intake: widget tool calls rewritten as plain text,
 * and their results dropped (the guest's answer follows as a guest message).
 *
 * With Sonnet 5.5's `thinking: between_tools`, a reply that follows a tool
 * call isn't streamed: the API holds the text back until it's complete
 * (measured: all of a ~600-token hand-off at once after 7 s, against first text
 * at 0.7 s without the tool history). The intake is over by the time the
 * planner runs, so it loses nothing by seeing it as text.
 */
export function flattenToolCalls(
  messages: readonly BaseMessage[],
  names: ReadonlySet<string>,
): BaseMessage[] {
  const flattened = new Set<string>();
  const out: BaseMessage[] = [];
  for (const message of messages) {
    if (AIMessage.isInstance(message) && message.tool_calls?.length) {
      const calls = message.tool_calls;
      if (calls.every((c) => names.has(c.name))) {
        calls.forEach((c) => c.id && flattened.add(c.id));
        const text = textBlocks(message.content);
        const shown = calls
          .map(
            (c) => `[Shown to the guest: ${c.name} ${JSON.stringify(c.args)}]`,
          )
          .join('\n');
        out.push(
          new AIMessage({
            id: message.id,
            content: [text, shown].filter(Boolean).join('\n'),
          }),
        );
        continue;
      }
    }
    if (ToolMessage.isInstance(message) && flattened.has(message.tool_call_id))
      continue;
    out.push(message);
  }
  return out;
}

function textBlocks(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) =>
      'text' in b && b.type === 'text' && typeof b.text === 'string'
        ? b.text
        : '',
    )
    .join('');
}
