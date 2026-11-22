import { EventEmitter } from 'node:events';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { IntakeService } from '../intake/intake.service.js';
import type { LangGraphClient } from './langgraph.client.js';
import { LangGraphController } from './langgraph.controller.js';

const identity = { givenName: 'Ana', surname: '', prefix: 'Dr' } as const;

function fakeReply() {
  const raw = Object.assign(new EventEmitter(), { writableFinished: false });
  const headers: Record<string, string> = {};
  const reply = {
    raw,
    headers,
    sent: undefined as unknown,
    header(name: string, value: string) {
      headers[name] = value;
      return reply;
    },
    send(body: unknown) {
      reply.sent = body;
      return reply;
    },
  };
  return reply;
}

function setup() {
  const intake = new IntakeService();
  const { conversationKey } = intake.setIdentity('chat1', identity, undefined);
  const client = {
    stream: vi.fn(
      async (..._args: unknown[]) =>
        new Response('event: values\ndata: {}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),
  };
  const controller = new LangGraphController(
    intake,
    client as unknown as LangGraphClient,
  );
  return { controller, client, intake, key: conversationKey! };
}

const message = (content: string) => ({
  input: { messages: [{ type: 'human', content }] },
});

describe('LangGraphController', () => {
  it("streams the guest's turn on the thread minted for this claim", async () => {
    const { controller, client, key } = setup();
    const reply = fakeReply();
    await controller.stream(
      'chat1',
      key,
      {
        ...message(' Lisbon '),
        // The SDK's transport sends these too; none may reach the agent.
        config: { configurable: { thread_id: 'other' } },
        context: { x: 1 },
        streamSubgraphs: true,
      },
      reply as never,
    );
    const [threadId, body] = client.stream.mock.calls[0] as [string, unknown];
    expect(threadId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body).toEqual({
      conversationId: 'chat1',
      input: { messages: [{ type: 'human', content: 'Lisbon' }] },
    });
    expect(reply.headers).toEqual({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
  });

  it('forwards a widget answer as a resume command', async () => {
    const { controller, client, key } = setup();
    await controller.stream(
      'chat1',
      key,
      {
        command: { resume: { type: 'interests', labels: ['Beaches'] } },
        input: null,
      },
      fakeReply() as never,
    );
    expect(client.stream.mock.calls[0][1]).toEqual({
      conversationId: 'chat1',
      command: { resume: { type: 'interests', labels: ['Beaches'] } },
    });
  });

  it('lets only the browser that claimed the conversation talk in it', async () => {
    const { controller, client } = setup();
    await expect(
      controller.stream('chat1', 'guess', message('hi'), fakeReply() as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.stream('nobody', 'k', message('hi'), fakeReply() as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(client.stream).not.toHaveBeenCalled();
  });

  it('validates the id and body', async () => {
    const { controller, key } = setup();
    for (const body of [
      {},
      message(''),
      message('x'.repeat(4001)),
      { command: { resume: { type: 'goto', node: 'planner' } } },
      { input: { messages: [{ type: 'ai', content: 'hi' }] } },
    ]) {
      await expect(
        controller.stream('chat1', key, body, fakeReply() as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      controller.stream('../x', key, message('hi'), fakeReply() as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('aborts upstream when the browser goes', async () => {
    const { controller, client, key } = setup();
    const reply = fakeReply();
    await controller.stream('chat1', key, message('hi'), reply as never);
    const signal = client.stream.mock.calls[0][2] as AbortSignal;
    reply.raw.emit('close');
    expect(signal.aborted).toBe(true);
  });

  it('gives a reclaimed conversation id a new thread', async () => {
    const { controller, client, key } = setup();
    await controller.stream('chat1', key, message('hi'), fakeReply() as never);
    // A restarted API (a fresh store) lets anyone claim the id again.
    const restarted = new IntakeService();
    const reclaimed = restarted.setIdentity('chat1', identity, undefined);
    await new LangGraphController(
      restarted,
      client as unknown as LangGraphClient,
    ).stream(
      'chat1',
      reclaimed.conversationKey,
      message('hi'),
      fakeReply() as never,
    );
    const [first, second] = client.stream.mock.calls.map((c) => c[0]);
    expect(second).not.toBe(first);
  });
});
