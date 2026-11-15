import {
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WebSearchResult } from '@travel-agent/shared';
import { searchProvider } from './search.module.js';
import {
  ProviderError,
  offProvider,
  type SearchProvider,
} from './search.provider.js';
import { SearchLimitedException, SearchService } from './search.service.js';
import { TAVILY_URL, TavilyProvider, trimSnippet } from './tavily.provider.js';

const QUERY = 'Lisbon events June 2027 for Ada Lovelace';
const API_KEY = 'tvly-secret-key';
const results: WebSearchResult[] = [
  { title: 'Santo António', url: 'https://example.com/a', snippet: 'June' },
];

function stub(impl?: SearchProvider['search']) {
  const search = vi.fn(impl ?? (() => Promise.resolve(results)));
  return { enabled: true, search } satisfies SearchProvider;
}

function service(provider: SearchProvider, env: Record<string, string> = {}) {
  return new SearchService(provider, new ConfigService(env));
}

/** Everything logged through Nest's Logger, as one string per call. */
function captureLogs() {
  const lines: { level: string; text: string }[] = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((msg: unknown) => {
      lines.push({ level, text: String(msg) });
    });
  }
  return lines;
}

/** The error a promise rejects with; fails the test if it resolves. */
async function rejection<E>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (err) {
    return err as E;
  }
  throw new Error('expected a rejection');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SearchService', () => {
  it('returns the provider results with the query and a timestamp', async () => {
    captureLogs();
    const provider = stub();
    const res = await service(provider).search({ query: '  Lisbon events ' });
    expect(res).toMatchObject({ query: 'Lisbon events', results });
    expect(new Date(res.searchedAt).toString()).not.toBe('Invalid Date');
    expect(provider.search).toHaveBeenCalledWith(
      { query: 'Lisbon events', maxResults: 5 },
      expect.any(AbortSignal),
    );
  });

  it('rejects invalid requests with 400', async () => {
    await expect(service(stub()).search({ query: 'x' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service(stub()).search({ query: 'Lisbon', maxResults: 9 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('caches by normalised query within the TTL and misses after it', async () => {
    vi.useFakeTimers();
    const logs = captureLogs();
    const provider = stub();
    const s = service(provider, { SEARCH_CACHE_TTL_SECONDS: '60' });

    await s.search({ query: 'Lisbon events' });
    await s.search({ query: 'LISBON   events' });
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.text.startsWith('search cached'))).toBe(true);

    // Different options are a different key.
    await s.search({ query: 'Lisbon events', maxResults: 3 });
    expect(provider.search).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(61_000);
    await s.search({ query: 'Lisbon events' });
    expect(provider.search).toHaveBeenCalledTimes(3);
  });

  it('enforces the per-minute rate limit, then refills', async () => {
    vi.useFakeTimers();
    const logs = captureLogs();
    const s = service(stub(), { SEARCH_RATE_PER_MINUTE: '2' });

    await s.search({ query: 'one query' });
    await s.search({ query: 'two query' });
    const err = await s.search({ query: 'three query' }).catch((e) => e);
    expect(err).toBeInstanceOf(SearchLimitedException);
    expect(err.getStatus()).toBe(429);
    expect(err.reason).toBe('rate');
    expect(logs).toContainEqual({
      level: 'warn',
      text: expect.stringMatching(/^search limited reason=rate /),
    });

    vi.advanceTimersByTime(30_000);
    await expect(s.search({ query: 'four query' })).resolves.toBeDefined();
  });

  it('enforces the daily cap until UTC midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-06-01T23:00:00Z'));
    const logs = captureLogs();
    const s = service(stub(), { SEARCH_DAILY_LIMIT: '1' });

    await s.search({ query: 'one query' });
    const err = await s.search({ query: 'two query' }).catch((e) => e);
    expect(err.reason).toBe('daily');
    expect(logs).toContainEqual({
      level: 'warn',
      text: expect.stringMatching(/^search limited reason=daily /),
    });
    // Cached queries are still served over the cap.
    await expect(s.search({ query: 'one query' })).resolves.toBeDefined();

    vi.setSystemTime(new Date('2027-06-02T00:00:01Z'));
    await expect(s.search({ query: 'two query' })).resolves.toBeDefined();
  });

  it('maps a provider timeout to 503', async () => {
    const logs = captureLogs();
    const provider = stub(
      (_req, signal) =>
        new Promise((_, reject) => {
          const fail = () => reject(new ProviderError('timeout'));
          if (signal.aborted) fail();
          else signal.addEventListener('abort', fail);
        }),
    );
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() =>
      AbortSignal.abort(new DOMException('timed out', 'TimeoutError')),
    );
    await expect(service(provider).search({ query: QUERY })).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(logs).toContainEqual({
      level: 'warn',
      text: expect.stringMatching(/^search error status=timeout /),
    });
  });

  it('maps the off provider to 503 without counting limits', async () => {
    captureLogs();
    const s = service(offProvider, { SEARCH_RATE_PER_MINUTE: '1' });
    for (let i = 0; i < 3; i++)
      await expect(s.search({ query: QUERY })).rejects.toThrow(
        ServiceUnavailableException,
      );
  });

  it('logs a hash and length, never the raw query', async () => {
    const logs = captureLogs();
    await service(stub()).search({ query: QUERY });
    expect(logs).toHaveLength(1);
    expect(logs[0].text).toMatch(
      /^search ok len=\d+ q=[0-9a-f]{8} results=1 ms=\d+$/,
    );
    expect(logs[0].text).not.toContain('Lisbon');
    expect(logs[0].text).not.toContain('Lovelace');
  });

  it('leaks neither the key, the query nor the body on a provider error', async () => {
    const logs = captureLogs();
    const body = 'upstream said: invalid key tvly-secret-key for Lisbon';
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(body, { status: 401 }))),
    );
    const err = await rejection<HttpException>(
      service(new TavilyProvider(API_KEY)).search({ query: QUERY }),
    );

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    const surfaces = [
      err.message,
      JSON.stringify(err.getResponse()),
      ...logs.map((l) => l.text),
    ].join('\n');
    expect(surfaces).toContain('status=401');
    for (const secret of [API_KEY, 'Lisbon', 'Lovelace', 'upstream said'])
      expect(surfaces).not.toContain(secret);
  });
});

describe('TavilyProvider', () => {
  function mockFetch(json: unknown) {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(Response.json(json)),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const sentBody = (f: ReturnType<typeof mockFetch>) =>
    JSON.parse(f.mock.calls[0][1].body as string) as Record<string, unknown>;

  it('sends a basic general search with the Bearer key', async () => {
    const f = mockFetch({ results: [] });
    await new TavilyProvider(API_KEY).search(
      { query: 'Lisbon events', maxResults: 5 },
      new AbortController().signal,
    );
    expect(f.mock.calls[0][0]).toBe(TAVILY_URL);
    expect(f.mock.calls[0][1].headers).toMatchObject({
      authorization: `Bearer ${API_KEY}`,
    });
    expect(sentBody(f)).toEqual({
      query: 'Lisbon events',
      max_results: 5,
      search_depth: 'basic',
      topic: 'general',
      include_answer: false,
      include_raw_content: false,
      include_published_date: true,
    });
  });

  it('maps recencyDays to start_date', async () => {
    const f = mockFetch({ results: [] });
    const now = () => new Date('2027-06-15T10:00:00Z');
    await new TavilyProvider(API_KEY, now).search(
      { query: 'Lisbon events', maxResults: 3, recencyDays: 14 },
      new AbortController().signal,
    );
    expect(sentBody(f)).toMatchObject({
      max_results: 3,
      start_date: '2027-06-01',
    });
    expect(sentBody(f)).not.toHaveProperty('days');
  });

  it('maps results, trims snippets and drops non-http(s) URLs', async () => {
    mockFetch({
      results: [
        {
          title: '  Festas de\n Lisboa ',
          url: 'https://example.com/festas',
          content: `${'word  '.repeat(200)}\n`,
          published_date: 'Tue, 11 Mar 2025 17:00:00 GMT',
          score: 0.9,
        },
        { title: 'Bad', url: 'javascript:alert(1)', content: 'x' },
        {
          title: '',
          url: 'https://example.com/b',
          content: 'b',
          published_date: null,
        },
      ],
    });
    const out = await new TavilyProvider(API_KEY).search(
      { query: 'Lisbon', maxResults: 5 },
      new AbortController().signal,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      title: 'Festas de Lisboa',
      url: 'https://example.com/festas',
      publishedAt: '2025-03-11T17:00:00.000Z',
    });
    expect(out[0].snippet.length).toBe(600);
    expect(out[0].snippet).not.toMatch(/\s{2}/);
    expect(out[1]).toEqual({
      title: 'https://example.com/b',
      url: 'https://example.com/b',
      snippet: 'b',
    });
  });

  it('trims long snippets with an ellipsis', () => {
    expect(trimSnippet('a'.repeat(700))).toHaveLength(600);
    expect(trimSnippet('a'.repeat(700)).endsWith('…')).toBe(true);
    expect(trimSnippet(' short\n\ttext ')).toBe('short text');
  });

  it('throws a ProviderError carrying only the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('limit', { status: 432 }))),
    );
    const err = await rejection<ProviderError>(
      new TavilyProvider(API_KEY).search(
        { query: 'Lisbon', maxResults: 5 },
        new AbortController().signal,
      ),
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(432);
    expect(err.message).toBe('Search provider error (432)');
  });
});

describe('searchProvider', () => {
  beforeEach(() => captureLogs());
  const pick = (env: Record<string, string>) =>
    searchProvider(new ConfigService(env));

  it('defaults to tavily with a key, off without one', () => {
    expect(pick({ TAVILY_API_KEY: 'k' })).toBeInstanceOf(TavilyProvider);
    expect(pick({})).toBe(offProvider);
  });

  it('honours SEARCH_PROVIDER=off and rejects unknown names', () => {
    expect(pick({ TAVILY_API_KEY: 'k', SEARCH_PROVIDER: 'off' })).toBe(
      offProvider,
    );
    expect(pick({ TAVILY_API_KEY: 'k', SEARCH_PROVIDER: 'google' })).toBe(
      offProvider,
    );
    expect(pick({ SEARCH_PROVIDER: 'tavily' })).toBe(offProvider);
  });
});
