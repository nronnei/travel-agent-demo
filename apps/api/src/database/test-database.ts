import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Database } from './database.module.js';
import { MIGRATIONS_FOLDER } from './migrate.js';
import * as schema from './schema/index.js';

/** An in-process Postgres (PGlite) with the real migrations applied, for specs. */
export async function testDatabase(): Promise<{
  db: Database;
  client: PGlite;
  close: () => Promise<void>;
}> {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db: db as unknown as Database, client, close: () => client.close() };
}
