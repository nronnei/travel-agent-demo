# The API's database

One Postgres database (`api`) for the whole backend, on the environment's
CloudNativePG cluster (`travel-agent-db`, declared by the Helm chart). Without
`DATABASE_URL` (plain `npm run dev`, unit tests), stores fall back to memory.

## Conventions

- **One Postgres schema per bounded area**, each in its own file under
  `schema/` (`intake.ts` → `pgSchema('intake')`). Re-export it from
  `schema/index.ts`, and add the file and schema name to `drizzle.config.ts`.
- **Tables don't reach across schemas**, except through a foreign key that's
  written down in both files.
- **Migrations are generated, committed, and never edited once merged:**
  change the TS schema, then `npm run db:generate -w @travel-agent/api -- --name <what>`.
  `npm run db:check -w @travel-agent/api` checks the migration history.
- The API applies pending migrations at startup, under an advisory lock
  (`migrate.ts`). There are no down migrations: roll back with a new one.

## Running against a real Postgres locally

```sh
docker run --rm -e POSTGRES_PASSWORD=x -p 5433:5432 postgres:18
DATABASE_URL=postgres://postgres:x@localhost:5433/postgres npm run dev -w @travel-agent/api
```

Only `localhost` may be used without TLS. In the cluster, `DATABASE_SSL_ROOT_CERT`
points at the cluster CA and the server is verified.

The specs run on PGlite (in-process Postgres). The `*.int.spec.ts` ones need a
real server and run only with `TEST_DATABASE_URL` set (same URL as above).
