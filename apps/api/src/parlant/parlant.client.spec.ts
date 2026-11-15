import {
  BadGatewayException,
  GoneException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ParlantClient } from './parlant.client.js';

// The client always passes a URL and a JSON string body.
const href = (url: unknown) => (url as URL).href;

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

function client(
  env: Record<string, string> = { PARLANT_API_URL: 'http://parlant:8800' },
) {
  return new ParlantClient(new ConfigService(env));
}

describe('ParlantClient', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const calls = () =>
    fetchMock.mock.calls.map(([url, init]) => [
      init?.method,
      href(url),
      init?.body ? JSON.parse(init.body as string) : undefined,
    ]);

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('creates a customer only when it does not exist yet', async () => {
    fetchMock.mockResolvedValueOnce(json(404)).mockResolvedValueOnce(json(201));
    await client().ensureCustomer('chat1');
    expect(calls()).toEqual([
      ['GET', 'http://parlant:8800/customers/chat1', undefined],
      ['POST', 'http://parlant:8800/customers', { id: 'chat1', name: 'chat1' }],
    ]);

    fetchMock.mockReset().mockResolvedValueOnce(json(200));
    await client().ensureCustomer('chat1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats Parlant's 500 on a duplicate customer as a race and re-checks", async () => {
    fetchMock
      .mockResolvedValueOnce(json(404))
      .mockResolvedValueOnce(json(500))
      .mockResolvedValueOnce(json(200));
    await client().ensureCustomer('chat1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('creates sessions for the agent and posts customer messages and cancels', async () => {
    fetchMock
      .mockResolvedValueOnce(json(201, { id: 'sess1' }))
      .mockResolvedValueOnce(json(201, { id: 'ev', offset: 7 }))
      .mockResolvedValueOnce(json(409));
    const c = client({
      PARLANT_API_URL: 'http://parlant:8800',
      PARLANT_AGENT_ID: 'ta',
    });
    expect(await c.createSession('chat1')).toBe('sess1');
    expect((await c.postMessage('sess1', 'Lisbon')).offset).toBe(7);
    await c.cancel('sess1'); // 409: nothing running, not an error
    expect(calls()).toEqual([
      [
        'POST',
        'http://parlant:8800/sessions',
        { agent_id: 'ta', customer_id: 'chat1' },
      ],
      [
        'POST',
        'http://parlant:8800/sessions/sess1/events',
        { kind: 'message', source: 'customer', message: 'Lisbon' },
      ],
      [
        'POST',
        'http://parlant:8800/sessions/sess1/events',
        { kind: 'status', source: 'customer', status: 'cancelled' },
      ],
    ]);
  });

  it('opens event streams from an offset or Last-Event-ID', async () => {
    fetchMock.mockResolvedValue(new Response('retry: 3000\n\n'));
    const signal = new AbortController().signal;
    await client().events('sess1', { minOffset: 8 }, signal);
    await client().events('sess1', { lastEventId: '12' }, signal);
    await client().event('sess1', 'ev1', signal);
    const [first, second, third] = fetchMock.mock.calls;
    expect(href(first[0])).toBe(
      'http://parlant:8800/sessions/sess1/events?sse=true&wait_for_data=60&min_offset=8',
    );
    expect(second[1]?.headers).toMatchObject({ 'last-event-id': '12' });
    expect(href(third[0])).toBe(
      'http://parlant:8800/sessions/sess1/events/ev1?sse=true&wait_for_data=60',
    );
  });

  it('maps errors and missing config', async () => {
    await expect(client({}).createSession('c')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    fetchMock.mockResolvedValueOnce(json(503));
    await expect(client().createSession('c')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(client().createSession('c')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('reports a session Parlant no longer has as gone, not as a bad gateway', async () => {
    fetchMock.mockResolvedValueOnce(
      json(404, { detail: "Session not found (id='s1')" }),
    );
    await expect(client().postMessage('s1', 'hi')).rejects.toBeInstanceOf(
      GoneException,
    );
  });
});
