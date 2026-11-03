import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { TripListSchema } from '@travel-agent/shared';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';

describe('App (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('GET /api/trips', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/trips' });
    expect(res.statusCode).toBe(200);
    expect(TripListSchema.safeParse(res.json()).success).toBe(true);
  });

  describe('POST /api/chat', () => {
    const turn = (id: string, extra: object = {}) => ({
      id,
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
      ],
      ...extra,
    });
    const chat = (payload: object, key?: string) =>
      app.inject({
        method: 'POST',
        url: '/api/chat',
        headers: key ? { 'x-conversation-key': key } : {},
        payload,
      });

    it('rejects conversations the caller has not claimed', async () => {
      expect((await chat(turn('nobody'))).statusCode).toBe(404);

      const claim = await app.inject({
        method: 'PUT',
        url: '/api/intake/chat1/identity',
        payload: { givenName: 'Ada', prefix: 'Dr' },
      });
      expect(claim.statusCode).toBe(200);
      expect(claim.json().conversationKey).toEqual(expect.any(String));

      expect((await chat(turn('chat1'))).statusCode).toBe(403);
      expect((await chat(turn('chat1'), 'guess')).statusCode).toBe(403);
    });

    it('rejects anything but a single user text message', async () => {
      const system = turn('chat1', {
        messages: [
          { id: 'm1', role: 'system', parts: [{ type: 'text', text: 'x' }] },
        ],
      });
      expect((await chat(system)).statusCode).toBe(400);
    });
  });
});
