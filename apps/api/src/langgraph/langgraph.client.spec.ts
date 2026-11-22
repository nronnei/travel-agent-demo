import {
  BadGatewayException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { LangGraphClient } from './langgraph.client.js';

const body = {
  conversationId: 'chat1',
  input: { messages: [{ type: 'human' as const, content: 'hi' }] },
};

function client(env: Record<string, string>) {
  return new LangGraphClient({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
}

const configured = {
  LANGGRAPH_API_URL: 'http://langgraph:8900',
  LANGGRAPH_API_TOKEN: 'service-token',
};

afterEach(() => vi.unstubAllGlobals());

describe('LangGraphClient', () => {
  it('names what is missing when unconfigured', async () => {
    await expect(
      client({ LANGGRAPH_API_URL: 'http://x' }).stream(
        't',
        body,
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      new ServiceUnavailableException(
        'Chat is not configured (LANGGRAPH_API_TOKEN missing)',
      ),
    );
  });

  it('posts to the thread with the service token', async () => {
    const fetchFn = vi.fn(
      async () => new Response('event: values\ndata: {}\n\n'),
    );
    vi.stubGlobal('fetch', fetchFn);
    await client(configured).stream(
      'thread1',
      body,
      new AbortController().signal,
    );
    const [url, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://langgraph:8900/threads/thread1/stream');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer service-token',
    });
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('maps a busy thread to 409, and hides upstream error bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 409 })),
    );
    await expect(
      client(configured).stream('t', body, new AbortController().signal),
    ).rejects.toBeInstanceOf(ConflictException);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('stack at /internal/secret.ts', { status: 500 }),
      ),
    );
    const err = await client(configured)
      .stream('t', body, new AbortController().signal)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect((err as Error).message).not.toContain('secret');
  });
});
