import { Pool } from 'pg';
import { runMigrations } from './migrate.js';

// Opt-in: TEST_DATABASE_URL=postgres://postgres:x@localhost:5433/postgres
// (docker run --rm -e POSTGRES_PASSWORD=x -p 5433:5432 postgres:18). PGlite
// can't exercise the advisory lock or concurrent connections.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('runMigrations (real Postgres)', () => {
  it('lets concurrent callers through one at a time, and both succeed', async () => {
    const pool = new Pool({ connectionString: url, max: 4 });
    try {
      await pool.query('drop schema if exists intake cascade; drop schema if exists drizzle cascade');
      await Promise.all([runMigrations(pool), runMigrations(pool)]);
      const { rows } = await pool.query<{ n: number }>(
        'select count(*)::int as n from drizzle.__drizzle_migrations',
      );
      expect(rows[0].n).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
