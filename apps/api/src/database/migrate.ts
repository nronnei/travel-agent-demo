import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

/** apps/api/drizzle, from both src/database (tests) and dist/database (the image). */
export const MIGRATIONS_FOLDER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'drizzle',
);

const LOCK_KEY = 'travel-agent-api-migrations';

/**
 * Applies pending migrations under a session-level advisory lock, so two API
 * pods starting together don't race. The lock is released when the
 * connection drops, even if the process dies mid-migration.
 */
export async function runMigrations(
  pool: Pool,
  migrationsFolder = MIGRATIONS_FOLDER,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    try {
      await migrate(drizzle({ client }), { migrationsFolder });
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export interface RetryOptions {
  /** Total time to keep trying, in ms (default 4 minutes: a first cluster bootstrap fits). */
  budgetMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (error: Error, nextDelayMs: number) => void;
}

/** Waits until Postgres answers, backing off from 1 s to 15 s; throws once the budget is spent. */
export async function waitForDatabase(
  pool: Pool,
  {
    budgetMs = 240_000,
    initialDelayMs = 1_000,
    maxDelayMs = 15_000,
    onRetry,
  }: RetryOptions = {},
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let delay = initialDelayMs;
  for (;;) {
    try {
      await pool.query('select 1');
      return;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (Date.now() + delay > deadline)
        throw new Error(
          `Postgres is unreachable after ${Math.round(budgetMs / 1000)}s: ${error.message}`,
        );
      onRetry?.(error, delay);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}
