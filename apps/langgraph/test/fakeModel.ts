import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { textOf } from '../src/graph.js';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';

export interface FakeCall {
  messages: BaseMessage[];
  tools: string[];
  options: Record<string, unknown>;
}

interface Shared {
  queue: (
    | AIMessage
    | ((messages: BaseMessage[]) => AIMessage | Promise<AIMessage>)
  )[];
  calls: FakeCall[];
}

let nextId = 0;

/**
 * Anthropic's ordering rule: every AI tool call is followed immediately by the
 * results of all its calls, before any other message.
 */
export function assertToolPairing(messages: readonly BaseMessage[]) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!AIMessage.isInstance(m) || !m.tool_calls?.length) continue;
    const ids = new Set(m.tool_calls.map((c) => c.id));
    let j = i + 1;
    while (j < messages.length && ToolMessage.isInstance(messages[j])) {
      ids.delete((messages[j] as ToolMessage).tool_call_id);
      j++;
    }
    if (ids.size)
      throw new Error(
        `tool_use without an immediately following tool_result: ${[...ids].join(', ')}`,
      );
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!ToolMessage.isInstance(m)) continue;
    const prev = messages
      .slice(0, i)
      .reverse()
      .find((x) => !ToolMessage.isInstance(x));
    if (
      !AIMessage.isInstance(prev) ||
      !prev.tool_calls?.some((c) => c.id === m.tool_call_id)
    )
      throw new Error(`tool_result out of place: ${m.tool_call_id}`);
  }
}

/**
 * A chat model that answers from a queue, records what it was sent, enforces
 * Anthropic's tool pairing, and streams its replies word by word.
 */
export class FakeChatModel extends BaseChatModel {
  readonly shared: Shared;
  private bound: { tools: string[]; options: Record<string, unknown> } = {
    tools: [],
    options: {},
  };

  constructor(queue: Shared['queue'] = [], shared?: Shared) {
    super({});
    this.shared = shared ?? { queue, calls: [] };
  }

  get calls() {
    return this.shared.calls;
  }

  push(...replies: Shared['queue']) {
    this.shared.queue.push(...replies);
  }

  _llmType() {
    return 'fake';
  }

  override bindTools(
    tools: { name: string }[],
    options: Record<string, unknown> = {},
  ): any {
    const bound = new FakeChatModel([], this.shared);
    bound.bound = { tools: tools.map((t) => t.name), options };
    return bound;
  }

  private async next(messages: BaseMessage[]): Promise<AIMessage> {
    assertToolPairing(messages);
    this.shared.calls.push({ messages, ...this.bound });
    const reply = this.shared.queue.shift();
    if (!reply) throw new Error('FakeChatModel: no reply queued');
    const message = typeof reply === 'function' ? await reply(messages) : reply;
    return new AIMessage({
      id: message.id ?? `fake-${++nextId}`,
      content: message.content,
      tool_calls: message.tool_calls,
    });
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const message = await this.next(messages);
    return { generations: [{ message, text: textOf(message.content) }] };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this['ParsedCallOptions'] & BaseChatModelCallOptions,
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const message = await this.next(messages);
    const words = textOf(message.content)
      .split(/(?<= )/)
      .filter(Boolean);
    for (const word of words) {
      const chunk = new ChatGenerationChunk({
        text: word,
        message: new AIMessageChunk({ id: message.id, content: word }),
      });
      yield chunk;
      await runManager?.handleLLMNewToken(word);
    }
    if (message.tool_calls?.length) {
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({
          id: message.id,
          content: '',
          tool_call_chunks: message.tool_calls.map((c, index) => ({
            id: c.id,
            name: c.name,
            args: JSON.stringify(c.args),
            index,
            type: 'tool_call_chunk' as const,
          })),
        }),
      });
    }
  }
}

/** An AI reply calling one tool. */
export const callTool = (
  name: string,
  args: Record<string, unknown>,
  id = `toolu_${++nextId}`,
  content = '',
) =>
  new AIMessage({
    content,
    tool_calls: [{ id, name, args, type: 'tool_call' }],
  });
