import { ToolMessage } from '@langchain/core/messages';
import { SearchClient } from '../apiClient.js';
import { SEARCH_UNAVAILABLE, webSearchTool } from './webSearch.js';

const response = {
  query: 'Lisbon events June 2027',
  searchedAt: '2026-11-22T10:00:00Z',
  results: [
    { title: 'Santo António', url: 'https://example.com/a', snippet: 'Festas' },
  ],
};

function call(fetchFn: typeof fetch, writer = vi.fn()) {
  const search = webSearchTool(
    new SearchClient('http://api:3000', 'search-token', fetchFn),
  );
  return {
    writer,
    run: () =>
      search.invoke(
        {
          type: 'tool_call',
          id: 'toolu_1',
          name: 'web_search',
          args: { query: 'Lisbon events June 2027', max_results: 20 },
        },
        { writer } as never,
      ) as Promise<ToolMessage>,
  };
}

describe('web_search', () => {
  it('announces the search, then returns results with sources as the artifact', async () => {
    const fetchFn = vi.fn(async () => Response.json(response));
    const { run, writer } = call(fetchFn as unknown as typeof fetch);
    const message = await run();
    expect(writer).toHaveBeenCalledWith({
      type: 'web-search',
      state: 'searching',
      query: 'Lisbon events June 2027',
    });
    expect(JSON.parse(message.content as string)).toEqual(response);
    expect(message.artifact).toEqual({
      search: {
        query: 'Lisbon events June 2027',
        sources: [{ title: 'Santo António', url: 'https://example.com/a' }],
      },
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://api:3000/api/search/web');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer search-token',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'Lisbon events June 2027',
      maxResults: 8,
    });
  });

  it.each([
    ['a 401', async () => new Response('no', { status: 401 })],
    [
      'a network error',
      async () => Promise.reject(new TypeError('fetch failed')),
    ],
    ['a malformed body', async () => Response.json({ nope: true })],
  ])('falls back on %s', async (_, impl) => {
    const { run } = call(vi.fn(impl) as unknown as typeof fetch);
    const message = await run();
    expect(message.content).toBe(SEARCH_UNAVAILABLE);
    expect(message.artifact).toEqual({
      search: { query: 'Lisbon events June 2027', error: true },
    });
  });
});
