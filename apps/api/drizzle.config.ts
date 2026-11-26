import { defineConfig } from 'drizzle-kit';

// `npm run db:generate` turns schema changes into SQL migrations in ./drizzle,
// which are committed and applied by the API at startup (src/database/migrate.ts).
// Add each new area's file to schema and its schema name to schemaFilter.
export default defineConfig({
  dialect: 'postgresql',
  // One entry per area's schema file (not index.ts: drizzle-kit can't follow its .js re-exports).
  schema: ['./src/database/schema/intake.ts'],
  out: './drizzle',
  schemaFilter: ['intake'],
});
