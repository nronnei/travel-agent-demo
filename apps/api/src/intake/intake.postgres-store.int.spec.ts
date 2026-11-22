import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Database } from '../database/database.module.js';
import { runMigrations } from '../database/migrate.js';
import * as schema from '../database/schema/index.js';
import { PostgresIntakeStore } from './intake.postgres-store.js';

// Opt-in against real Postgres (see src/database/README.md): PGlite runs one
// statement at a time, so it can't show these races.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PostgresIntakeStore races (real Postgres)', () => {
  let pool: Pool;
  let store: PostgresIntakeStore;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 8 });
    await runMigrations(pool);
    store = new PostgresIntakeStore(drizzle({ client: pool, schema }) as unknown as Database);
  });
  beforeEach(() => pool.query('truncate intake.conversations'));
  afterAll(() => pool.end());

  const record = (threadId: string) => ({
    keyHash: Buffer.alloc(32, 2),
    threadId,
    identity: { givenName: 'Ana', surname: '', prefix: 'Dr' as const },
  });

  it('lets exactly one of two concurrent claims win', async () => {
    const results = await Promise.all([
      store.claim('c1', record('t1')),
      store.claim('c1', record('t2')),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('gives concurrent Parlant session writers the same session', async () => {
    await store.claim('c1', record('t1'));
    const sessions = await Promise.all([
      store.setParlantSession('c1', 's1'),
      store.setParlantSession('c1', 's2'),
    ]);
    expect(sessions[0]).toBe(sessions[1]);
  });
});
