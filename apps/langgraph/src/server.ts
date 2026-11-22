import { randomUUID, timingSafeEqual } from 'node:crypto';
import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import {
  BRIEF_CONFIRMED_MESSAGE,
  LangGraphRunRequestSchema,
  ThreadIdSchema,
  interestsAnswer,
  type LangGraphRunRequest,
  type WidgetAnswer,
} from '@travel-agent/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { RECURSION_LIMIT, type TravelGraph } from './graph.js';
import { PING, encodeChunk, frame } from './sse.js';

export const STREAM_MODES = [
  'values',
  'messages',
  'updates',
  'custom',
] as const;
export const ERROR_MESSAGE = 'The agent hit a problem. Please try again.';

/** How long a new run waits for an aborted run on the same thread to unwind. */
const UNWIND_WAIT_MS = 5_000;

export interface ServerOptions {
  graph: TravelGraph;
  /** The Bearer token the Nest API sends; empty means the stream route is 503. */
  apiToken: string;
  pingMs?: number;
  /** How long a new run waits for an aborted run on the same thread to unwind. */
  unwindWaitMs?: number;
  logger?: boolean;
}

interface Run {
  abort: AbortController;
  done: Promise<void>;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A widget answer when nothing is waiting for one: the same text the app would send. */
function answerAsText(answer: WidgetAnswer): string {
  if (answer.type === 'interests') return interestsAnswer(answer.labels);
  if (answer.type === 'confirm') return BRIEF_CONFIRMED_MESSAGE;
  return answer.text;
}

export function buildServer({
  graph,
  apiToken,
  pingMs = 15_000,
  unwindWaitMs = UNWIND_WAIT_MS,
  logger = true,
}: ServerOptions): FastifyInstance {
  const app = Fastify({ logger });
  const runs = new Map<string, Run>();

  app.get('/healthz', async () => ({ ok: true }));

  app.post<{ Params: { threadId: string } }>(
    '/threads/:threadId/stream',
    async (request, reply) => {
      if (!apiToken)
        return reply
          .code(503)
          .send({ message: 'LANGGRAPH_API_TOKEN is not set' });
      const auth = request.headers.authorization ?? '';
      if (!safeEqual(auth, `Bearer ${apiToken}`))
        return reply.code(401).send({ message: 'Unauthorized' });
      const threadId = ThreadIdSchema.safeParse(request.params.threadId);
      if (!threadId.success)
        return reply.code(400).send({ message: 'Invalid thread id' });
      const body = LangGraphRunRequestSchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ message: 'Invalid request' });
      const thread = threadId.data;

      // Claim the thread synchronously, before any await, so two requests
      // can't both pass. A live run refuses; an aborted one (Stop, then an
      // immediate resend) is waited for while it unwinds.
      const previous = runs.get(thread);
      if (previous && !previous.abort.signal.aborted)
        return reply
          .code(409)
          .send({ message: 'A reply is already in progress' });
      let finish!: () => void;
      const run: Run = {
        abort: new AbortController(),
        done: new Promise<void>((resolve) => (finish = resolve)),
      };
      runs.set(thread, run);
      const release = () => {
        if (runs.get(thread) === run) runs.delete(thread);
        finish();
      };
      // Listen before any await: a 'close' that fires while waiting below
      // isn't delivered again, and the run would go on with nobody reading.
      reply.raw.on('error', () => undefined);
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) run.abort.abort();
      });
      if (previous) {
        const settled = await Promise.race([
          previous.done.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), unwindWaitMs)),
        ]);
        if (!settled) {
          // The old run is still going: keep it guarding the thread, so a
          // retry waits for it too instead of starting a second run.
          if (runs.get(thread) === run) runs.set(thread, previous);
          finish();
          return reply
            .code(409)
            .send({ message: 'A reply is already in progress' });
        }
        // The browser left while we waited.
        if (run.abort.signal.aborted || request.raw.socket?.destroyed) {
          release();
          return reply;
        }
      }

      const config = {
        configurable: {
          thread_id: thread,
          conversation_id: body.data.conversationId,
        },
      };
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });
      const ping = setInterval(() => reply.raw.write(PING), pingMs);
      try {
        const input = await decideInput(graph, config, body.data);
        const stream = await graph.stream(input as never, {
          ...config,
          streamMode: [...STREAM_MODES],
          recursionLimit: RECURSION_LIMIT,
          signal: run.abort.signal,
        });
        for await (const [mode, chunk] of stream as AsyncIterable<
          [string, unknown]
        >) {
          reply.raw.write(encodeChunk(mode, chunk));
        }
      } catch (err) {
        if (!run.abort.signal.aborted) {
          const errorId = randomUUID().slice(0, 8);
          request.log.error({ err, thread, errorId }, 'run failed');
          reply.raw.write(frame('error', { message: ERROR_MESSAGE, errorId }));
        }
      } finally {
        clearInterval(ping);
        reply.raw.end();
        release();
      }
    },
  );

  return app;
}

/**
 * The server, not the browser, decides whether a request resumes: the browser
 * can lose track of a pending widget after a Stop or an error. A thread
 * counts as paused when awaitGuest is next (even if an abort landed before it
 * raised its interrupt) or a task holds an interrupt.
 */
export async function decideInput(
  graph: TravelGraph,
  config: { configurable: { thread_id: string } },
  body: LangGraphRunRequest,
): Promise<unknown> {
  const state = await graph.getState(config);
  const paused =
    state.next.includes('awaitGuest') ||
    state.tasks.some((t) => t.interrupts?.length);
  if ('command' in body) {
    return paused
      ? new Command({ resume: body.command.resume })
      : { messages: [new HumanMessage(answerAsText(body.command.resume))] };
  }
  const text = body.input.messages[0].content;
  return paused
    ? new Command({ resume: { type: 'reply', text } satisfies WidgetAnswer })
    : { messages: [new HumanMessage(text)] };
}
