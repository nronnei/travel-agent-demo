import { sql } from 'drizzle-orm';
import { testDatabase } from '../database/test-database.js';
import { conversations } from '../database/schema/index.js';
import { PostgresIntakeStore } from './intake.postgres-store.js';
import { intakeStoreContract } from './intake.store.contract.js';

intakeStoreContract('PostgresIntakeStore (PGlite)', async () => {
  const { db, close } = await testDatabase();
  return { store: new PostgresIntakeStore(db), close };
});

describe('PostgresIntakeStore', () => {
  const record = {
    keyHash: Buffer.alloc(32, 1),
    threadId: 't1',
    identity: { givenName: 'Ana', surname: '', prefix: 'Dr' as const },
  };

  it('treats a row that fails validation as absent', async () => {
    const { db, close } = await testDatabase();
    const store = new PostgresIntakeStore(db);
    await store.claim('c1', record);
    await db
      .update(conversations)
      .set({ identity: sql`'{"givenName": 42}'::jsonb` })
      .where(sql`conversation_id = 'c1'`);
    expect(await store.get('c1')).toBeUndefined();
    await close();
  });

  it('bumps updated_at and last_seen_at on update; touch only after an hour', async () => {
    const { db, client, close } = await testDatabase();
    const store = new PostgresIntakeStore(db);
    await store.claim('c1', record);
    const stamps = async () =>
      (
        await client.query<{ u: string; s: string }>(
          `select updated_at::text as u, last_seen_at::text as s from intake.conversations`,
        )
      ).rows[0];
    await client.query(
      `update intake.conversations set updated_at = now() - interval '2 hours',
       last_seen_at = now() - interval '30 minutes'`,
    );
    const before = await stamps();
    await store.touch('c1'); // seen 30 minutes ago: not bumped
    expect(await stamps()).toEqual(before);

    await client.query(`update intake.conversations set last_seen_at = now() - interval '2 hours'`);
    await store.touch('c1');
    const touched = await stamps();
    expect(touched.s > before.s).toBe(true);
    expect(touched.u).toBe(before.u);

    await store.update('c1', { identity: { givenName: 'Bo', surname: '', prefix: 'Mx' } });
    expect((await stamps()).u > before.u).toBe(true);
    await close();
  });

  it('enforces the row cap on claim, at most once a minute', async () => {
    const { db, close } = await testDatabase();
    let now = 0;
    const store = new PostgresIntakeStore(db, 1, () => now);
    now = 60_000;
    await store.claim('a', { ...record, threadId: 'ta' });
    now = 70_000; // within the minute: not checked yet
    await store.claim('b', { ...record, threadId: 'tb' });
    expect(await store.get('a')).toBeDefined();
    now = 130_000;
    await store.claim('c', { ...record, threadId: 'tc' });
    expect(await store.get('b')).toBeUndefined();
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('c')).toBeDefined();
    await close();
  });
});
