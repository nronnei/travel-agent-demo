import { Logger } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { WebSearchResponseSchema } from '@travel-agent/shared';
import { configureApp } from '../app.setup.js';
import { SearchModule } from './search.module.js';
import { SEARCH_PROVIDER, type SearchProvider } from './search.provider.js';

const TOKEN = 'search-token';

async function app(env: Record<string, string>, provider: SearchProvider) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      // Never read the developer's .env: a real key must not reach these tests.
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        ignoreEnvVars: true,
        load: [() => env],
      }),
      SearchModule,
    ],
  })
    .overrideProvider(SEARCH_PROVIDER)
    .useValue(provider)
    .compile();
  const a = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  configureApp(a);
  await a.init();
  await a.getHttpAdapter().getInstance().ready();
  return a;
}

const stub: SearchProvider = {
  enabled: true,
  search: () =>
    Promise.resolve([
      { title: 'A', url: 'https://example.com/a', snippet: 'a' },
    ]),
};

describe('POST /api/search/web', () => {
  let a: NestFastifyApplication | undefined;
  let warn: ReturnType<typeof vi.fn<(message: unknown) => void>>;
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.fn<(message: unknown) => void>();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(warn);
  });
  afterEach(async () => {
    await a?.close();
    a = undefined;
    vi.restoreAllMocks();
  });

  const post = (payload: object, auth?: string) =>
    a!.inject({
      method: 'POST',
      url: '/api/search/web',
      headers: auth ? { authorization: auth } : {},
      payload,
    });

  it('returns results with the right token', async () => {
    a = await app({ SEARCH_API_TOKEN: TOKEN }, stub);
    const res = await post({ query: 'Lisbon events' }, `Bearer ${TOKEN}`);
    expect(res.statusCode).toBe(200);
    expect(WebSearchResponseSchema.parse(res.json()).results).toHaveLength(1);
  });

  it('rejects a missing or wrong token with 401', async () => {
    a = await app({ SEARCH_API_TOKEN: TOKEN }, stub);
    expect((await post({ query: 'Lisbon' })).statusCode).toBe(401);
    expect((await post({ query: 'Lisbon' }, 'Bearer nope')).statusCode).toBe(
      401,
    );
    expect((await post({ query: 'Lisbon' }, TOKEN)).statusCode).toBe(401);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('status=401'));
  });

  it('fails closed with 503 when the token is not configured', async () => {
    a = await app({}, stub);
    expect((await post({ query: 'Lisbon' }, 'Bearer ')).statusCode).toBe(503);
    expect((await post({ query: 'Lisbon' }, `Bearer x`)).statusCode).toBe(503);
  });

  it('rejects a bad body with 400', async () => {
    a = await app({ SEARCH_API_TOKEN: TOKEN }, stub);
    expect((await post({ query: 'x' }, `Bearer ${TOKEN}`)).statusCode).toBe(
      400,
    );
    expect((await post({}, `Bearer ${TOKEN}`)).statusCode).toBe(400);
  });

  it('returns 503 when the provider is off', async () => {
    a = await app(
      { SEARCH_API_TOKEN: TOKEN },
      { enabled: false, search: () => Promise.reject(new Error('off')) },
    );
    expect(
      (await post({ query: 'Lisbon' }, `Bearer ${TOKEN}`)).statusCode,
    ).toBe(503);
  });
});
