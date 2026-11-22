import { IntakeService } from '../intake/intake.service.js';
import { MemoryIntakeStore } from '../intake/intake.memory-store.js';
import type { ParlantClient } from './parlant.client.js';
import { ParlantService } from './parlant.service.js';

const identity = { givenName: 'Ana', surname: '', prefix: 'Dr' } as const;

function fakeClient() {
  let n = 0;
  return {
    ensureCustomer: vi.fn(async () => {}),
    createSession: vi.fn(async () => `sess${++n}`),
  };
}

async function setup(store = new MemoryIntakeStore()) {
  const intake = new IntakeService(store);
  const client = fakeClient();
  const service = new ParlantService(client as unknown as ParlantClient, intake);
  const claim = async (id: string) => {
    const { conversationKey } = await intake.setIdentity(id, identity, undefined);
    return conversationKey!;
  };
  const record = (id: string, key: string) => intake.authorize(id, key);
  return { intake, client, service, claim, record, store };
}

describe('ParlantService', () => {
  it('creates one customer and session per claim, even under concurrency', async () => {
    const { client, service, claim, record } = await setup();
    const key1 = await claim('chat1');
    const r1 = await record('chat1', key1);
    const [a, b] = await Promise.all([
      service.sessionFor('chat1', r1),
      service.sessionFor('chat1', r1),
    ]);
    expect(a).toBe('sess1');
    expect(b).toBe('sess1');
    const key2 = await claim('chat2');
    expect(await service.sessionFor('chat2', await record('chat2', key2))).toBe('sess2');
    expect(client.ensureCustomer.mock.calls).toEqual([['chat1'], ['chat2']]);
  });

  it('keeps the session on the intake record, so it survives an API restart', async () => {
    const store = new MemoryIntakeStore();
    const first = await setup(store);
    const key = await first.claim('chat1');
    await first.service.sessionFor('chat1', await first.record('chat1', key));

    // A new ParlantService (a restarted API) over the same stored records.
    const restarted = new ParlantService(
      fakeClient() as unknown as ParlantClient,
      new IntakeService(store),
    );
    const record = await new IntakeService(store).authorize('chat1', key);
    expect(await restarted.sessionFor('chat1', record)).toBe('sess1');
  });

  it("gives a conversation id reclaimed after retention a new session, not the old guest's", async () => {
    const { intake, service, claim, record } = await setup();
    const key = await claim('chat1');
    expect(await service.sessionFor('chat1', await record('chat1', key))).toBe('sess1');

    await intake.prune(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const newKey = await claim('chat1');
    expect(newKey).not.toBe(key);
    expect(await service.sessionFor('chat1', await record('chat1', newKey))).toBe('sess2');
  });

  it('retries after a failed creation', async () => {
    const { client, service, claim, record } = await setup();
    const key = await claim('chat1');
    client.createSession.mockRejectedValueOnce(new Error('down'));
    await expect(service.sessionFor('chat1', await record('chat1', key))).rejects.toThrow('down');
    expect(await service.sessionFor('chat1', await record('chat1', key))).toBe('sess1');
  });

  it('starts a new session after forgetting one', async () => {
    const { client, service, claim, record } = await setup();
    const key = await claim('chat1');
    await service.sessionFor('chat1', await record('chat1', key));
    await service.forget('chat1');
    expect(await service.sessionFor('chat1', await record('chat1', key))).toBe('sess2');
    expect(client.createSession).toHaveBeenCalledTimes(2);
  });
});
