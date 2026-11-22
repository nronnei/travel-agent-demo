import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { runMigrations, waitForDatabase, type RetryOptions } from './migrate.js';
import * as schema from './schema/index.js';
import { sslOptions } from './ssl-options.js';

/**
 * The API's database: driver-neutral, so stores take node-postgres in the app
 * and PGlite in tests. `null` when DATABASE_URL is unset (npm run dev, tests),
 * and stores fall back to memory.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
export const DATABASE = Symbol('DATABASE');
const DATABASE_POOL = Symbol('DATABASE_POOL');

const logger = new Logger('Database');

/**
 * Connects (retrying while a fresh cluster bootstraps) and migrates before the
 * app starts listening. Never logs the URL.
 */
export async function openPool(
  url: string,
  caFile: string | undefined,
  retry?: RetryOptions,
): Promise<Pool> {
  const pool = new Pool({
    connectionString: url,
    max: 5,
    ssl: sslOptions(url, caFile, 'DATABASE_SSL_ROOT_CERT'),
  });
  pool.on('error', (err) => logger.error(`Idle client error: ${err.message}`));
  try {
    await waitForDatabase(pool, {
      onRetry: (err, delay) =>
        logger.warn(`Postgres not reachable yet (${err.message}); retrying in ${delay / 1000}s`),
      ...retry,
    });
    await runMigrations(pool);
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw err;
  }
  logger.log('Connected; migrations applied');
  return pool;
}

@Injectable()
class PoolShutdown implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool | null) {}

  async onApplicationShutdown() {
    await this.pool?.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('DATABASE_URL');
        if (!url) return null;
        return openPool(url, config.get<string>('DATABASE_SSL_ROOT_CERT') || undefined);
      },
    },
    {
      provide: DATABASE,
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool | null): Database | null =>
        pool ? drizzle({ client: pool, schema }) : null,
    },
    PoolShutdown,
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
