import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { MIGRATIONS_FOLDER } from './migrate.js';

describe('migrations', () => {
  it('create the intake schema and are idempotent', async () => {
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const { rows } = await client.query<{ name: string }>(
      `select table_schema || '.' || table_name as name from information_schema.tables
       where table_schema = 'intake'`,
    );
    expect(rows.map((r) => r.name)).toEqual(['intake.conversations']);
    const applied = await client.query<{ n: number }>(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    expect(applied.rows[0].n).toBe(1);
    await client.close();
  });
});
