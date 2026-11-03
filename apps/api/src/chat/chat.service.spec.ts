import { Readable } from 'node:stream';
import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatService } from './chat.service.js';

const env = {
  INKEEP_AGENTS_API_URL: 'http://inkeep:3002',
  INKEEP_AGENTS_RUN_API_BYPASS_SECRET: 's3cret',
  INKEEP_TENANT_ID: 'default',
  INKEEP_PROJECT_ID: 'travel-agent',
  INKEEP_AGENT_ID: 'travel-agent',
  INTAKE_API_TOKEN: 'intake-tok',
};

const body = {
  id: 'chat123',
  messages: [
    {
      id: 'm1',
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'Hi' }],
    },
  ],
};

function service(overrides: Record<string, string | undefined> = {}) {
  return new ChatService(new ConfigService({ ...env, ...overrides }));
}

describe('ChatService', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('forwards to the Inkeep run API with server-side auth and the chat id as conversationId', async () => {
    fetchMock.mockResolvedValue(new Response('data: {}\n\n', { status: 200 }));

    const stream = await service().stream(body, new AbortController().signal);

    expect(stream).toBeInstanceOf(Readable);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect((url as URL).href).toBe('http://inkeep:3002/run/api/chat');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer s3cret',
      'x-inkeep-tenant-id': 'default',
      'x-inkeep-project-id': 'travel-agent',
      'x-inkeep-agent-id': 'travel-agent',
      'x-travel-conversation-id': 'chat123',
      'x-intake-token': 'intake-tok',
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      ...body,
      conversationId: 'chat123',
    });
  });

  it('prepends a brief the guest edited in the app', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    await service().stream(
      {
        ...body,
        brief: { destination: 'Kyoto', purpose: 'a honeymoon', interests: [] },
      },
      new AbortController().signal,
    );

    const sent = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(sent.brief).toBeUndefined();
    expect(sent.messages[0].parts[0].text).toBe(
      "[I've edited the trip brief myself. It now reads: destination: Kyoto; purpose: a honeymoon; interests: none.]\n\nHi",
    );
  });

  it('is unavailable when Inkeep is not configured', async () => {
    await expect(
      service({ INKEEP_AGENTS_RUN_API_BYPASS_SECRET: undefined }).stream(
        body,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps upstream errors to 502', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));

    await expect(
      service().stream(body, new AbortController().signal),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps connection failures to 502', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      service().stream(body, new AbortController().signal),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
