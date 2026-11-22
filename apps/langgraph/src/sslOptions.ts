// A copy of apps/api/src/database/ssl-options.ts (shared can't hold node:fs code: the web app imports it).
import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * TLS for a Postgres connection, failing closed:
 * - with a CA file, verify the server against it (host name included);
 * - without one, connect in plain text only to a local database (npm run dev);
 * - any other host without a CA refuses to start.
 * An sslmode in the URL is rejected, because node-postgres lets it override
 * the ssl option and would silently drop the CA check.
 */
export function sslOptions(
  connectionString: string,
  caFile: string | undefined,
  caVariable: string,
): ConnectionOptions | false {
  const url = new URL(connectionString);
  if (url.searchParams.has('sslmode'))
    throw new Error(
      `Remove sslmode from the database URL: TLS is set by ${caVariable}`,
    );
  if (caFile)
    return { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
  if (LOCAL_HOSTS.has(url.hostname)) return false;
  throw new Error(
    `${caVariable} is not set, and the database host ${url.hostname} is not local: refusing to connect without verifying TLS`,
  );
}
