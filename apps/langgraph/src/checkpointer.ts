import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import pg from 'pg';
import type { Config } from './config.js';
import { sslOptions } from './sslOptions.js';

export interface Checkpointer {
  saver: BaseCheckpointSaver;
  close: () => Promise<void>;
}

export interface RetryOptions {
  /** Pool size (default 5; the in-process test server takes one connection). */
  poolMax?: number;
  /** Total time to keep trying, in ms (default 4 minutes: a first cluster bootstrap fits). */
  budgetMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (error: Error, nextDelayMs: number) => void;
}

/** Waits until Postgres answers, backing off from 1 s to 15 s; throws once the budget is spent. */
export async function waitForDatabase(
  pool: pg.Pool,
  { budgetMs = 240_000, initialDelayMs = 1_000, maxDelayMs = 15_000, onRetry }: RetryOptions = {},
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

/**
 * Postgres in the cluster (the service's own database), SQLite on a local file,
 * or memory (tests). Postgres creates its tables on first use (setup()).
 */
export async function createCheckpointer(
  config: Config,
  retry?: RetryOptions,
): Promise<Checkpointer> {
  if (config.LANGGRAPH_CHECKPOINTER === 'memory')
    return { saver: new MemorySaver(), close: async () => {} };
  if (config.LANGGRAPH_CHECKPOINTER === 'postgres') {
    const url = config.LANGGRAPH_DATABASE_URL!;
    const pool = new pg.Pool({
      connectionString: url,
      max: retry?.poolMax ?? 5,
      ssl: sslOptions(url, config.LANGGRAPH_DATABASE_SSL_ROOT_CERT, 'LANGGRAPH_DATABASE_SSL_ROOT_CERT'),
    });
    pool.on('error', (err) => console.error(`Postgres idle client error: ${err.message}`));
    try {
      await waitForDatabase(pool, {
        onRetry: (err, delay) =>
          console.warn(`Postgres not reachable yet (${err.message}); retrying in ${delay / 1000}s`),
        ...retry,
      });
      const saver = new PostgresSaver(pool);
      await saver.setup();
      return { saver, close: () => pool.end() };
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw err;
    }
  }
  mkdirSync(dirname(config.LANGGRAPH_DB), { recursive: true });
  const saver = SqliteSaver.fromConnString(config.LANGGRAPH_DB);
  return { saver, close: async () => {} };
}
