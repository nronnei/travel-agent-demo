import { Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  WEB_SEARCH_TOOL_DESCRIPTION,
  WebSearchResponseSchema,
} from '@travel-agent/shared';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import {
  SEARCH_PROVIDER,
  type SearchProvider,
} from '../src/search/search.provider.js';

const TOKEN = 'e2e-search-token';

describe('MCP /api/mcp (e2e)', () => {
  let app: NestFastifyApplication;
  let url: URL;
  const provider = {
    enabled: true,
    search: vi.fn<SearchProvider['search']>(() =>
      Promise.resolve([
        { title: 'Festas', url: 'https://example.com/festas', snippet: 'June' },
      ]),
    ),
  };

  beforeAll(async () => {
    // Set before compiling, so ConfigService sees it whatever the local .env holds.
    process.env.SEARCH_API_TOKEN = TOKEN;
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SEARCH_PROVIDER)
      .useValue(provider)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configureApp(app);
    // The SDK client makes real HTTP requests, so app.inject isn't enough.
    await app.listen(0, '127.0.0.1');
    url = new URL('/api/mcp', await app.getUrl());
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  async function connect(token?: string) {
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: token
          ? { headers: { authorization: `Bearer ${token}` } }
          : {},
      }),
    );
    return client;
  }

  it('lists web_search with the shared description', async () => {
    const client = await connect(TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['web_search']);
    expect(tools[0].description).toBe(WEB_SEARCH_TOOL_DESCRIPTION);
    expect(tools[0].inputSchema.properties).toHaveProperty('query');
    await client.close();
  });

  it('returns a parseable WebSearchResponse from callTool', async () => {
    const client = await connect(TOKEN);
    const result = await client.callTool({
      name: 'web_search',
      arguments: { query: 'Lisbon events June 2027' },
    });
    expect(result.isError).toBeFalsy();
    const [content] = result.content as { type: string; text: string }[];
    const response = WebSearchResponseSchema.parse(JSON.parse(content.text));
    expect(response.results[0].url).toBe('https://example.com/festas');
    expect(provider.search).toHaveBeenCalledWith(
      { query: 'Lisbon events June 2027', maxResults: 5 },
      expect.any(AbortSignal),
    );
    await client.close();
  });

  it('returns isError, not a failure, when the provider fails', async () => {
    provider.search.mockRejectedValueOnce(new Error('boom'));
    const client = await connect(TOKEN);
    const result = await client.callTool({
      name: 'web_search',
      arguments: { query: 'Porto wine cellars opening hours' },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('rejects a client without the token', async () => {
    await expect(connect()).rejects.toThrow(/401/);
    await expect(connect('wrong')).rejects.toThrow(/401/);
  });

  it('answers GET with 405', async () => {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
  });
});
