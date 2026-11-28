import { IntakeClient, SearchClient } from './apiClient.js';

const context = {
  address: 'Dr Lima',
  givenName: 'Ana',
  surname: 'Lima',
  prefix: 'Dr',
  destination: '',
  purpose: '',
  interests: '',
  briefConfirmed: 'no',
};

describe('IntakeClient', () => {
  it('reads the context with the intake token', async () => {
    const fetchFn = vi.fn(async () => Response.json(context));
    const client = new IntakeClient(
      'http://api:3000',
      'intake-token',
      fetchFn as unknown as typeof fetch,
    );
    await expect(client.context('conv_1')).resolves.toEqual(context);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://api:3000/api/intake/conv_1/context');
    expect(init.headers).toEqual({ 'x-intake-token': 'intake-token' });
  });

  it('saves a draft with PUT', async () => {
    const fetchFn = vi.fn(async () => Response.json(context));
    const client = new IntakeClient(
      'http://api:3000',
      't',
      fetchFn as unknown as typeof fetch,
    );
    const brief = {
      destination: 'Lisbon',
      purpose: 'a food tour',
      interests: [],
    };
    await client.saveDraft('conv_1', brief);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://api:3000/api/intake/conv_1/draft');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual(brief);
  });

  it('throws on a failed response', async () => {
    const client = new IntakeClient(
      'http://api:3000',
      't',
      (async () =>
        new Response('', { status: 500 })) as unknown as typeof fetch,
    );
    await expect(client.context('c')).rejects.toThrow('500');
  });
});

describe('SearchClient', () => {
  it('sends the search token and names itself in x-search-client', async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ query: 'q', searchedAt: '2027-06-01T00:00:00Z', results: [] }),
    );
    const client = new SearchClient(
      'http://api:3000',
      'search-token',
      fetchFn as unknown as typeof fetch,
    );
    await client.search({ query: 'Lisbon events', maxResults: 5 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://api:3000/api/search/web');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer search-token',
      'x-search-client': 'langgraph',
    });
  });
});
