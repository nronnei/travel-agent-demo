import { MemoryIntakeStore } from './intake.memory-store.js';
import { intakeStoreContract } from './intake.store.contract.js';
import { TOUCH_INTERVAL_MS } from './intake.store.js';

intakeStoreContract('MemoryIntakeStore', async () => ({ store: new MemoryIntakeStore() }));

describe('MemoryIntakeStore', () => {
  const record = (threadId: string) => ({
    keyHash: Buffer.alloc(32),
    threadId,
    identity: { givenName: 'Ana', surname: '', prefix: 'Dr' as const },
  });

  it('evicts the least recently active claim beyond its cap', async () => {
    const store = new MemoryIntakeStore(2);
    await store.claim('a', record('ta'));
    await store.claim('b', record('tb'));
    await store.claim('c', record('tc'));
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('b')).toBeDefined();
  });

  it('counts a touch as activity at most once an hour', async () => {
    let now = 0;
    const store = new MemoryIntakeStore(10, () => now);
    await store.claim('a', record('ta'));
    now = TOUCH_INTERVAL_MS - 1;
    await store.touch('a');
    // Not bumped yet: an hour after the claim, 'a' counts as inactive.
    expect(await store.prune(new Date(TOUCH_INTERVAL_MS - 1 + 1), 10)).toBe(1);

    await store.claim('b', record('tb'));
    now += TOUCH_INTERVAL_MS;
    await store.touch('b');
    expect(await store.prune(new Date(now), 10)).toBe(0);
  });
});
