import type { IntakeRecord, IntakeStore } from './intake.store.js';

/** Behavior both intake stores must share; each store's spec runs it. */
export function intakeStoreContract(
  name: string,
  make: () => Promise<{ store: IntakeStore; close?: () => Promise<void> }>,
) {
  const record = (threadId = 't1'): IntakeRecord => ({
    keyHash: Buffer.alloc(32, 7),
    threadId,
    identity: { givenName: 'Ana', surname: '', prefix: 'Dr' },
  });

  describe(`${name} (intake store contract)`, () => {
    let store: IntakeStore;
    let close: (() => Promise<void>) | undefined;
    beforeEach(async () => {
      ({ store, close } = await make());
    });
    afterEach(async () => {
      await close?.();
    });

    it('claims an id once, and reads it back', async () => {
      expect(await store.claim('c1', record())).toBe(true);
      expect(await store.claim('c1', record('t2'))).toBe(false);
      const got = await store.get('c1');
      expect(got).toMatchObject({ threadId: 't1', identity: { givenName: 'Ana' } });
      expect(Buffer.isBuffer(got?.keyHash)).toBe(true);
      expect(got?.keyHash.equals(Buffer.alloc(32, 7))).toBe(true);
      expect(await store.get('nobody')).toBeUndefined();
    });

    it('applies patches', async () => {
      await store.claim('c1', record());
      const trip = { destination: 'Lisbon', purpose: 'a long weekend', interests: [] };
      await store.update('c1', { draft: trip });
      await store.update('c1', { identity: { givenName: 'Bo', surname: '', prefix: 'Mx' } });
      expect(await store.get('c1')).toMatchObject({
        identity: { givenName: 'Bo' },
        draft: { destination: 'Lisbon' },
      });
      expect((await store.get('c1'))?.trip).toBeUndefined();
    });

    it('keeps the first Parlant session set, until cleared', async () => {
      await store.claim('c1', record());
      expect(await store.setParlantSession('c1', 's1')).toBe('s1');
      expect(await store.setParlantSession('c1', 's2')).toBe('s1');
      await store.clearParlantSession('c1');
      expect(await store.setParlantSession('c1', 's3')).toBe('s3');
      expect(await store.setParlantSession('nobody', 's4')).toBeUndefined();
    });

    it('prunes records with no recent activity, and the oldest beyond the cap', async () => {
      await store.claim('a', record('ta'));
      await store.claim('b', record('tb'));
      await store.claim('c', record('tc'));
      // Nothing is older than an hour ago.
      expect(await store.prune(new Date(Date.now() - 3_600_000), 10)).toBe(0);
      // Cap of 2: the least recently active ('a') goes.
      expect(await store.prune(new Date(Date.now() - 3_600_000), 2)).toBe(1);
      expect(await store.get('a')).toBeUndefined();
      expect(await store.get('c')).toBeDefined();
      // Everything is older than a minute from now.
      expect(await store.prune(new Date(Date.now() + 60_000), 10)).toBe(2);
      expect(await store.get('c')).toBeUndefined();
    });
  });
}
