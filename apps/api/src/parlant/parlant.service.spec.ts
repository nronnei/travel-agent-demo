import type { ParlantClient } from './parlant.client.js';
import { ParlantService } from './parlant.service.js';

function fakeClient() {
  let n = 0;
  return {
    ensureCustomer: vi.fn(async () => {}),
    createSession: vi.fn(async () => `sess${++n}`),
  };
}

describe('ParlantService', () => {
  it('creates one customer and session per conversation, even under concurrency', async () => {
    const client = fakeClient();
    const service = new ParlantService(client as unknown as ParlantClient);
    const [a, b] = await Promise.all([
      service.sessionFor('chat1'),
      service.sessionFor('chat1'),
    ]);
    expect(a).toBe('sess1');
    expect(b).toBe('sess1');
    expect(await service.sessionFor('chat2')).toBe('sess2');
    expect(client.ensureCustomer.mock.calls).toEqual([['chat1'], ['chat2']]);
  });

  it('retries after a failed creation', async () => {
    const client = fakeClient();
    client.createSession.mockRejectedValueOnce(new Error('down'));
    const service = new ParlantService(client as unknown as ParlantClient);
    await expect(service.sessionFor('chat1')).rejects.toThrow('down');
    expect(await service.sessionFor('chat1')).toBe('sess1');
  });

  it('starts a new session after forgetting one', async () => {
    const client = fakeClient();
    const service = new ParlantService(client as unknown as ParlantClient);
    await service.sessionFor('chat1');
    service.forget('chat1');
    await service.sessionFor('chat1');
    expect(client.createSession).toHaveBeenCalledTimes(2);
  });
});
