import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
} from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import {
  FetchStreamTransport,
  MessageTupleManager,
} from '@langchain/langgraph-sdk/ui';
import {
  BRIEF_CONFIRMED_MESSAGE,
  type IntakeContext,
} from '@travel-agent/shared';
import type { FastifyInstance } from 'fastify';
import { FakeChatModel, callTool } from '../test/fakeModel.js';
import type { IntakeClient, SearchClient } from './apiClient.js';
import { buildGraph, type TravelGraph } from './graph.js';
import { ERROR_MESSAGE, buildServer, decideInput } from './server.js';
import { messageDict } from './sse.js';

const TOKEN = 'service-token';
const THREAD = 'AAAAAAAAAAAAAAAAAAAAAA';
const intake: IntakeContext = {
  address: 'Dr Lima',
  givenName: 'Ana',
  surname: 'Lima',
  prefix: 'Dr',
  destination: '',
  purpose: '',
  interests: '',
  briefConfirmed: 'no',
};

let app: FastifyInstance;
let base: string;
let intakeModel: FakeChatModel;
let context: ReturnType<typeof vi.fn>;

async function start(apiToken = TOKEN, pingMs = 15_000) {
  intakeModel = new FakeChatModel();
  context = vi.fn(async () => ({ ...intake }));
  const graph = buildGraph({
    models: { intake: intakeModel, planner: new FakeChatModel() },
    intakeClient: {
      context,
      saveDraft: vi.fn(async () => undefined),
    } as unknown as IntakeClient,
    searchClient: { search: vi.fn() } as unknown as SearchClient,
    checkpointer: new MemorySaver(),
  });
  app = buildServer({ graph, apiToken, pingMs, logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

afterEach(async () => {
  await app?.close();
});

const human = (content: string) => ({
  conversationId: 'conv-1',
  input: { messages: [{ type: 'human', content }] },
});

function post(
  body: unknown,
  opts: { token?: string; thread?: string; signal?: AbortSignal } = {},
) {
  return fetch(`${base}/threads/${opts.thread ?? THREAD}/stream`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.token ?? TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}

/** A reply the fake model only gives once `release` is called. */
function gated(reply: AIMessage) {
  let release!: () => void;
  const ready = new Promise<void>((r) => (release = r));
  return { release, reply: async () => (await ready, reply) };
}

describe('the LangGraph server', () => {
  it('needs the service token', async () => {
    await start();
    expect((await post(human('hi'), { token: 'wrong' })).status).toBe(401);
  });

  it('is 503 without a configured token', async () => {
    await start('');
    expect((await post(human('hi'))).status).toBe(503);
  });

  it('rejects a malformed thread id and body', async () => {
    await start();
    expect((await post(human('hi'), { thread: 'conv-1' })).status).toBe(400);
    expect((await post({ conversationId: 'conv-1', config: {} })).status).toBe(
      400,
    );
  });

  it('streams SSE with messages in the SDK dict form', async () => {
    await start();
    intakeModel.push(new AIMessage('And what brings you to Lisbon?'));
    const res = await post(human('Lisbon'));
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const text = await res.text();
    expect(text).toContain('event: values');
    expect(text).toContain('event: messages');
    expect(text).not.toContain('"lc":1');
    expect(text).toContain('"type":"ai"');
  });

  it('works end to end with the SDK transport, interrupt included', async () => {
    await start();
    intakeModel.push(
      callTool(
        'suggest_interests',
        { destination: 'Lisbon', extras: [] },
        'w1',
        'Splendid.',
      ),
    );
    const transport = new FetchStreamTransport({
      apiUrl: `${base}/threads/${THREAD}/stream`,
      defaultHeaders: { authorization: `Bearer ${TOKEN}` },
      onRequest: (_url, init) => ({
        ...init,
        body: JSON.stringify({
          ...JSON.parse(init.body as string),
          conversationId: 'conv-1',
        }),
      }),
    });
    const events = await transport.stream({
      input: { messages: [{ type: 'human', content: 'A getaway' }] },
      context: undefined,
      command: undefined,
      signal: new AbortController().signal,
    } as never);
    const tuples = new MessageTupleManager();
    let interrupt: unknown;
    for await (const { event, data } of events) {
      if (event === 'messages')
        tuples.add((data as [never, never])[0], (data as [never, never])[1]);
      if (event === 'values' && (data as Record<string, unknown>).__interrupt__)
        interrupt = (data as { __interrupt__: { value: unknown }[] })
          .__interrupt__[0].value;
    }
    expect(interrupt).toMatchObject({
      toolCallId: 'w1',
      widget: { name: 'InterestPicker' },
    });
    const streamed = Object.values(tuples.chunks).map((c) => c.chunk);
    expect(
      streamed.some(
        (m) => AIMessageChunk.isInstance(m) && m.content === 'Splendid.',
      ),
    ).toBe(true);
  });

  it('turns a guest message on a paused thread into a reply to the widget', async () => {
    await start();
    intakeModel.push(
      callTool(
        'present_brief',
        { destination: 'Lisbon', purpose: 'a food tour', interests: [] },
        'w1',
      ),
    );
    await (await post(human('A food tour'))).text();
    intakeModel.push(new AIMessage('Of course.'));
    await (await post(human('Actually, make it Porto'))).text();
    const sent = intakeModel.calls[1].messages;
    const answer = sent.find(
      (m) => ToolMessage.isInstance(m) && m.tool_call_id === 'w1',
    );
    expect(answer?.content).toBe(
      'The guest answered in their own words: Actually, make it Porto',
    );
  });

  it('runs a widget answer as input when nothing is waiting for one', async () => {
    await start();
    intakeModel.push(new AIMessage('Wonderful.'));
    await (
      await post({
        conversationId: 'conv-1',
        command: { resume: { type: 'confirm' } },
      })
    ).text();
    expect(intakeModel.calls[0].messages.at(-1)?.content).toBe(
      BRIEF_CONFIRMED_MESSAGE,
    );
  });

  it('refuses a second run while one is live', async () => {
    await start();
    const slow = gated(new AIMessage('Done.'));
    intakeModel.push(slow.reply);
    const first = post(human('one'));
    await vi.waitFor(() => expect(intakeModel.calls).toHaveLength(1));
    expect((await post(human('two'))).status).toBe(409);
    slow.release();
    await (await first).text();
  });

  it('waits for an aborted run to unwind instead of refusing', async () => {
    await start();
    const slow = gated(new AIMessage('Too late.'));
    intakeModel.push(slow.reply);
    const abort = new AbortController();
    const first = post(human('one'), { signal: abort.signal });
    await vi.waitFor(() => expect(intakeModel.calls).toHaveLength(1));
    abort.abort();
    await first.catch(() => undefined);
    intakeModel.push(new AIMessage('Second answer.'));
    const second = post(human('two'));
    setTimeout(() => slow.release(), 100);
    const res = await second;
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Second answer.');
  });

  it('pings an idle stream', async () => {
    await start(TOKEN, 20);
    const slow = gated(new AIMessage('Done.'));
    intakeModel.push(slow.reply);
    setTimeout(() => slow.release(), 120);
    expect(await (await post(human('one'))).text()).toContain(': ping');
  });

  it('sends only a fixed message when a run fails', async () => {
    await start();
    context.mockRejectedValueOnce(
      new Error('GET http://travel-agent-api:3000 failed\n    at secret.ts:1'),
    );
    const text = await (await post(human('one'))).text();
    expect(text).toContain('event: error');
    expect(text).toContain(ERROR_MESSAGE);
    expect(text).not.toContain('travel-agent-api');
    expect(text).not.toContain('secret.ts');
  });
});

describe('decideInput', () => {
  const fakeGraph = (next: string[], interrupts: unknown[] = []) =>
    ({
      getState: async () => ({ next, tasks: [{ interrupts }] }),
    }) as unknown as TravelGraph;
  const config = { configurable: { thread_id: THREAD } };

  it('counts a thread whose next step is awaitGuest as paused, even without an interrupt', async () => {
    const input = await decideInput(
      fakeGraph(['awaitGuest']),
      config,
      human('Porto') as never,
    );
    expect(input).toMatchObject({ resume: { type: 'reply', text: 'Porto' } });
  });

  it('runs a message on an idle thread as input', async () => {
    const input = (await decideInput(
      fakeGraph([]),
      config,
      human('Porto') as never,
    )) as {
      messages: AIMessage[];
    };
    expect(input.messages[0].content).toBe('Porto');
  });
});

describe('messageDict', () => {
  it('drops thinking blocks', () => {
    const dict = messageDict(
      new AIMessage({
        id: 'm1',
        content: [
          { type: 'thinking', thinking: 'secret', signature: 'sig' },
          { type: 'text', text: 'Hello' },
        ],
      }),
    );
    expect(dict).toMatchObject({
      type: 'ai',
      id: 'm1',
      content: [{ type: 'text', text: 'Hello' }],
    });
  });
});

describe('the run lock with a run slow to stop', () => {
  /** A graph whose runs ignore abort until released, like a stuck model call. */
  function stubbornGraph() {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const streams: number[] = [];
    const graph = {
      getState: async () => ({ next: [], tasks: [] }),
      stream: async () => {
        streams.push(Date.now());
        return (async function* () {
          await released;
          yield ['values', { messages: [] }];
        })();
      },
    } as unknown as TravelGraph;
    return { graph, release, streams };
  }

  async function serve(graph: TravelGraph, unwindWaitMs = 50) {
    app = buildServer({ graph, apiToken: TOKEN, logger: false, unwindWaitMs });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }

  it('keeps refusing while an aborted run is still going, instead of letting a retry in', async () => {
    const stub = stubbornGraph();
    await serve(stub.graph);
    const abort = new AbortController();
    const first = post(human('one'), { signal: abort.signal });
    await vi.waitFor(() => expect(stub.streams).toHaveLength(1));
    abort.abort();
    await first.catch(() => undefined);
    expect((await post(human('two'))).status).toBe(409);
    expect((await post(human('three'))).status).toBe(409);
    expect(stub.streams).toHaveLength(1);
    stub.release();
    await vi.waitFor(async () =>
      expect((await post(human('four'))).status).toBe(200),
    );
  });

  it('does not start a run for a browser that left while waiting', async () => {
    const stub = stubbornGraph();
    await serve(stub.graph, 2_000);
    const abortFirst = new AbortController();
    const first = post(human('one'), { signal: abortFirst.signal });
    await vi.waitFor(() => expect(stub.streams).toHaveLength(1));
    abortFirst.abort();
    await first.catch(() => undefined);
    const abortSecond = new AbortController();
    const second = post(human('two'), { signal: abortSecond.signal });
    setTimeout(() => abortSecond.abort(), 10);
    await second.catch(() => undefined);
    // Let the server see the disconnect, then let the old run finish.
    await new Promise((r) => setTimeout(r, 100));
    stub.release();
    await new Promise((r) => setTimeout(r, 100));
    expect(stub.streams).toHaveLength(1);
  });
});
