---
title: Standard Postgres on CloudNativePG for the API, the agent backends and Inkeep
status: implementing
revision: 6
updated: 2026-11-22
reviewed: rev 4 (architecture, security, risk)
issue:
artifact: https://claude.ai/artifact/6w2jBu6YDr9kQrUZTgD33u
base: e7600be36faa7711621f8a24acb32f43074128fb
---

# Standard Postgres on CloudNativePG for the API, the agent backends and Inkeep

## Summary
Every server-side store that can run on Postgres moves to CloudNativePG (CNPG). The operator (1.30.2) is already running in the homelab.

Each environment gets **one** CNPG cluster: `travel-agent-db` in `travel-agent` (prod), and another in `travel-agent-dev`. Each service gets its own database and login role inside that cluster:

- **The Nest API** gets a database for the whole backend, with one Postgres schema per use case. The first schema is `intake`, which replaces today's in-memory `IntakeService` map.
- **LangGraph** moves its checkpoints from SQLite to the official Postgres checkpointer.
- **Parlant** moves its sessions and customers from SQLite to Postgres, through a `DocumentDatabase` adapter we write. It's reusable in any Parlant app.
- **Inkeep** (the homelab install, one for both environments) gets one cluster of its own. Its run DB and SpiceDB DB move into it with their data. Doltgres stays.

## Goals
- **One cluster per environment.** The chart declares a single CNPG `Cluster`, `<fullname>-db`, behind `postgres.enabled`. It's off by default; the homelab values and `values-dev.yaml` turn it on.
- **A database and role per service:**
  - `api` is the bootstrap database. Its owner's credentials are in the operator's `-app` Secret.
  - `langgraph` and `parlant` come from `Database` + `DatabaseRole` CRs, each behind `<component>.postgres.enabled`.
  - `pg_hba` lets each role connect only to its own database, and only over TLS.
- **API:**
  - With `DATABASE_URL` set, the API stores intake records in Postgres (`intake.conversations`) and they survive restarts.
  - Without it (`npm run dev`, unit tests), it falls back to today's in-memory store and logs a warning once.
  - Drizzle migrations live in `apps/api/drizzle/` and are applied at startup under an advisory lock.
  - New areas of the API each get their own schema.
- **Intake retention:** intake records are deleted after `INTAKE_RETENTION_DAYS` (default **7**) with no *activity*. Activity means a write, or a chat turn that authorizes (tracked in `last_seen_at`). A row cap, `INTAKE_MAX_CONVERSATIONS` (default 10,000), bounds the table the way the memory store's LRU does today.
- **Parlant sessions belong to the claim, not the conversation id.** The Parlant session id is stored on the intake record (`parlant_session_id`). It survives API restarts and is deleted with the record, so a reclaimed id never reaches an earlier guest's session.
- **LangGraph:** with `LANGGRAPH_CHECKPOINTER=postgres`, checkpoints live in the `langgraph` database. SQLite and memory stay available for local runs and tests.
- **Parlant:**
  - With `PARLANT_DATABASE_URL` set, sessions (with their events) and customers live in the `parlant` database, through `travel_agent/postgres_db.py` `PostgresDocumentDatabase`.
  - Without it, Parlant uses its `local` SQLite store, as today.
  - The adapter passes one contract test suite that also runs against Parlant's own `SQLiteDocumentDatabase`.
- **TLS:** all three services connect over TLS and verify the server against the cluster's CA (`<cluster>-ca`). They fail closed: with no CA configured, a service refuses to connect to any host other than `localhost`/`127.0.0.1`.
- **Tilt:** `tilt up` (any `--chat-backend`) brings up the dev cluster and its databases. The Tilt UI groups them with their workloads, and `tilt down` leaves the cluster in place.
- **Homelab Inkeep:**
  - one `inkeep-db` cluster with the `inkeep_agents` database (imported) and the `spicedb` database (restored);
  - `agents-api`, its migrate init container and SpiceDB point at it;
  - the old `inkeep-postgres` and `inkeep-spicedb-postgres` StatefulSets are removed after a soak period.
- **PG 18 everywhere new.** The homelab template's default image becomes `ghcr.io/cloudnative-pg/postgresql:18`.
- **Docs:** `docs/agent-frameworks.md` records each framework's storage options and what it took to get onto Postgres.
- **Checks:** `npm run lint`, `npm run typecheck`, `npm test`, `uv run pytest` and `ruff check` (in `apps/parlant`) all pass. So do `helm lint` and `helm template`, with Postgres on and off.

## Non-goals
- **Doltgres.** Inkeep's manage DB stays on Doltgres, which isn't Postgres.
- **Backups.** These need S3-compatible storage the homelab doesn't have yet; Longhorn replication is the only protection, as today. This is a follow-up.
- **Postgres in local `docker compose`.** The user plans to drop compose. Local runs use the memory/SQLite fallbacks; step 4 shows how to point a local run at a throwaway `postgres:18`.
- **Migrating existing dev data.** LangGraph checkpoints and Parlant sessions are throwaway dev conversations, and their intake records (in memory) are gone after any API restart anyway.
- **A custom Parlant `CustomerStore` over an app users table.** That's a different feature: it would let us keep guest PII out of Parlant's storage. It belongs with the guest-data work and is a follow-up.
- **New API features beyond intake.**
- **Retention for LangGraph checkpoints and Parlant sessions.** They're existing gaps, and they stay follow-ups.
- **More than one replica** for any service or database.

## Context
### Homelab CNPG
- **Operator:** `cnpg-system`, image `ghcr.io/cloudnative-pg/cloudnative-pg:1.30.2`. The CRDs include `clusters`, `databases`, `databaseroles` and `poolers`.
  - `DatabaseRole` supports `passwordSecret` (a `kubernetes.io/basic-auth` Secret with `username` and `password`), `login`, `inRoles`, and `databaseRoleReclaimPolicy` (`retain`/`delete`).
  - It also supports `clientCertificate` (operator-issued client certs), which this plan doesn't use.
- **Convention:** `../../homelab/apps/cloudnative-pg/cluster-template.yaml`:
  - one instance;
  - `postgresql:17`;
  - `longhorn-workers`, 5Gi;
  - an amd64 nodeSelector;
  - requests 25m/128Mi, limit 512Mi;
  - `bootstrap.initdb {database, owner}`;
  - a `PodMonitor`.

  The operator generates `APP-db-app` (`username`, `password`, `host`, `port`, `dbname`, `uri`) and `APP-db-rw`.
- **Existing use:** `mealie/mealie-db` runs this way on PG 17. The README says backups aren't configured.

### API (`apps/api`, ESM, NodeNext)
- **`IntakeService`** (`src/intake/intake.service.ts`) is a synchronous, in-memory `Map<string, IntakeRecord>` with a 10,000-record LRU cap. An `IntakeRecord` holds `keyHash: Buffer`, `threadId`, `identity: GuestIdentity`, and optionally `trip` and `draft` (`TripBriefProps`).
- **Call sites:**
  - `intake/intake.controller.ts:47,61,82,83,97`
  - `chat/chat.controller.ts:36`
  - `parlant/parlant.controller.ts:106`
  - `langgraph/langgraph.controller.ts:44`
  - plus the specs and `test/*.e2e-spec.ts`.
- **No database today.**
- **Health:** `health/health.controller.ts` runs `check([])`. `/api/health` is the startup, readiness *and* liveness probe for every pod (`_helpers.tpl`).
- **Shared schemas:** `packages/shared/src/intake.ts` exports `GuestIdentitySchema` and `TripBriefPropsSchema`.

### LangGraph (`apps/langgraph`)
- **Checkpointer:** `src/checkpointer.ts` `createCheckpointer(config)` returns either `SqliteSaver.fromConnString(LANGGRAPH_DB)` or a `MemorySaver`.
- **Config:** `src/config.ts` has `LANGGRAPH_CHECKPOINTER: z.enum(['sqlite','memory'])`.
- **Package:** `@langchain/langgraph-checkpoint-postgres` 1.1.4 peers on `@langchain/langgraph-checkpoint ^1.2.0` (we have ^1.2.3) and uses `pg`. `PostgresSaver.setup()` creates its tables.

### Parlant (`apps/parlant`, Parlant 4.0.5, Python 3.12)
- **Startup:** `main.py` starts `p.Server(session_store="local", customer_store="local")`. `local` is one SQLite file per store under `PARLANT_HOME` (`sdk.py:4778`).
- **Other store options:** `transient`, `mongodb://…` or `s3://…` strings, or a `SessionStore` / `CustomerStore` instance (`sdk.py:4817`). Passing an instance skips Parlant's own store construction.
- **Store constructors:**
  - `SessionDocumentStore(database, allow_migration=False, collections_prefix=None)` (`core/sessions.py:732`);
  - `CustomerDocumentStore(id_generator, database, allow_migration=False, collections_prefix=None)` (`core/customers.py:208`).

  Both are async context managers, and both sit on the generic `DocumentDatabase` / `DocumentCollection` ABCs in `core/persistence/document_database.py`:
  - **database:** `create_collection`, `get_collection`, `get_or_create_collection`, `delete_collection`;
  - **collection:** `find` (filters, limit, cursor, sort), `find_one`, `ensure_indexes`, `insert_one`, `update_one` (with `upsert`), `delete_one`.
- **The reference adapter**, `adapters/db/sqlite.py` (540 lines):
  - keeps one `documents(collection_name, id, creation_utc, document_json)` table;
  - loads a whole collection and filters in Python with `persistence.common.matches_filters`;
  - pages with a `(creation_utc, id)` cursor;
  - holds an in-process `ReaderWriterLock`;
  - does compare-and-swap updates when the filter includes `metadata_revision: {$eq}` (patching fields with `json_set` in a single statement).
- **The Mongo adapter** uses `collections_prefix` to share one database between stores. Ours does the same.
- **Other files under `PARLANT_HOME`:** `indexing_cache.json` (an embedding cache, `sdk.py:4994`) and logs.
- **Chart:** `templates/parlant.yaml` mounts a PVC at `PARLANT_HOME` when `parlant.persistence.enabled`. Dev turns it on.
- **The Parlant client in the API:** `apps/api/src/parlant/parlant.client.ts` shows `SESSION_GONE_MESSAGE` when Parlant has lost a session.
- **Tests:** `apps/parlant/tests/` uses pytest, pytest-asyncio and respx.

### Chart and Tilt
- **Deployment helper:** `travel-agent.deployment` supports literal `env`, `envFromSecret`, `volumes` and `volumeMounts`, but not `valueFrom`.
- **Tiltfile:**
  - applies `helm()` output, so `lookup` is empty and no Helm hooks run;
  - `dev_secret(name, keys)` builds dev Secrets from `.env`;
  - toggles `parlant.enabled` / `langgraph.enabled` from `--chat-backend`;
  - groups objects with `k8s_resource(objects=...)`.
- **What's running:** dev runs Parlant and LangGraph with Longhorn PVCs. Prod runs only the API, the web app and Inkeep.
- **Env setup:** `scripts/init-env.sh` fills `<generated>` values in `.env.example`. Its `rand()` strips `/+=`, so the values are URL-safe.
- **Turbo:** `turbo.json` `dev.passThroughEnv` must list any new env var.

### Homelab Inkeep (`../../homelab/helm-values/inkeep.yaml`, bjw-s app-template 5.3.0)
- **Databases today:**
  - StatefulSet `doltgres` (the manage DB);
  - StatefulSet `postgres` (`postgres:18`, `inkeep_agents`, 10Gi);
  - StatefulSet `spicedb-postgres` (`postgres:16-alpine`, `spicedb`, 2Gi).
- **Connection strings:** `INKEEP_AGENTS_RUN_DATABASE_URL` and `SPICEDB_DATASTORE_CONN_URI` live in `inkeep-secrets`. That Secret is written by `scripts/generate-inkeep-secret.sh`; the file `apps/inkeep/inkeep-secret.yaml` is gitignored.
- **Data at stake:** the run DB holds conversations and auth. SpiceDB holds the authorization relationships. Losing either breaks Inkeep for both travel-agent environments.

## Assumptions
- **A1.** `ghcr.io/cloudnative-pg/postgresql:18` exists and CNPG 1.30 supports it. Check with `docker manifest inspect`.
- **A2.** `bootstrap.initdb.import` (type `microservice`) can import `inkeep_agents` from the plain `postgres:18` server, using its `POSTGRES_USER`, which is a superuser.
- **A3.** Inkeep 0.80.4 and SpiceDB 1.49.2 work as a **non-superuser** that owns all the objects. Today `appuser` is a superuser on the old run DB. Things to check: the old DB's extensions (`\dx`) must all exist in the CNPG image, and neither `agents-migrate` nor SpiceDB's `migrate head` may need superuser (`CREATE EXTENSION`, `pg_catalog` writes). SpiceDB 1.49.2 must also run on PG 18. Step 11's rehearsal checks all of this before the real cutover.
- **A4.** CNPG's server certificate covers `<cluster>-rw`, `<cluster>-rw.<ns>` and `<cluster>-rw.<ns>.svc`.
- **A5.** CNPG puts its own `pg_hba` rules (local and `streaming_replica`) *before* `spec.postgresql.pg_hba`, and its default `host all all all scram-sha-256` *after* it. So a trailing user rule `host all all all reject` blocks every role/database pair we haven't allowed, without breaking the operator.
- **A6.** Drizzle works under the API's NodeNext ESM and Vitest setup, and `drizzle-orm/pglite` runs the same migrations against `@electric-sql/pglite`.
- **A7.** `@electric-sql/pglite-socket` can serve `pg.Pool({ max: 1 })` well enough for `PostgresSaver.setup()` plus a round trip. If not, that test becomes opt-in.
- **A8.** `SessionDocumentStore` and `CustomerDocumentStore` work when constructed and entered outside `p.Server`, with an `IdGenerator()` we construct ourselves, and are accepted as instances by `p.Server(session_store=…, customer_store=…)`.
- **A9.** The hot read paths in Parlant's stores (events by `session_id`, documents by `id`) filter by scalar `$eq` on fields that no `document_loader` rewrites. That's what allows those fields, and only those, to be pushed down to SQL. Check by logging the filters the stores pass during a test run, and by reading each store's loader.
- **A10.** Existing dev data is disposable.

## Design

```mermaid
flowchart LR
  subgraph ns["travel-agent (prod) / travel-agent-dev: one cluster each"]
    api[travel-agent-api] -- "DATABASE_URL" --> db
    lg[travel-agent-langgraph] -- "LANGGRAPH_DATABASE_URL" --> db
    pa[travel-agent-parlant] -- "PARLANT_DATABASE_URL" --> db
    db[("travel-agent-db<br/>db api (schemas intake, drizzle)<br/>db langgraph<br/>db parlant")]
  end
  subgraph inkeep["inkeep namespace (homelab repo)"]
    ia[agents-api] --> idb
    sp[spicedb] --> idb
    idb[("inkeep-db<br/>db inkeep_agents (imported)<br/>db spicedb (restored)")]
    ia --> dolt[(Doltgres, unchanged)]
  end
```

### One cluster per environment, a database and role per service
The chart renders one `Cluster`, `<fullname>-db` (for example `travel-agent-db`), whenever `postgres.enabled` is set:

- **`api`:** the bootstrap database (`initdb {database: api, owner: api}`). The operator writes `travel-agent-db-app`, so the API needs no hand-made secret.
- **`langgraph`, `parlant`:** each one, when its `<component>.postgres.enabled` is set, gets:
  - a `DatabaseRole` (`login: true`, `passwordSecret: travel-agent-db-<component>`, `databaseRoleReclaimPolicy: retain`);
  - a `Database` (`name: <component>`, `owner: <component>`, `databaseReclaimPolicy: retain`).

  These flags don't depend on `<component>.enabled`, the same way the PVCs work today, so the databases outlive backend switches in Tilt.
- **Isolation, set in `spec.postgresql.pg_hba`:**
  ```
  hostssl api       api       all scram-sha-256
  hostssl langgraph langgraph all scram-sha-256
  hostssl parlant   parlant   all scram-sha-256
  host    all       all       all reject
  ```
  Each service can reach only its own database, and only over TLS. The operator's own connections are unaffected (A5). `enableSuperuserAccess: false`. The trailing reject line sits behind `postgres.isolation.rejectOthers` (default `true`), so it can be turned off by values alone if A5 turns out wrong.
- **Object names:** the cluster is `<fullname>-db`. Each backend's `DatabaseRole`, `Database` and basic-auth Secret are all named `<fullname>-db-<component>` (for example `travel-agent-db-parlant`); the role and database inside Postgres are named `<component>`. Tilt selectors use these names.
- **Role passwords.** The `basic-auth` Secrets for `langgraph` and `parlant` can't come from the chart: Tilt has no `lookup` or hooks, and regenerating a password on every render would break the role.
  - **Dev:** the Tiltfile makes them from the new `.env` keys `LANGGRAPH_DB_PASSWORD` and `PARLANT_DB_PASSWORD`, which `init-env.sh` generates. A new helper, `basic_auth_secret(name, username, key)`, wraps `dev_secret`.
  - **Prod:** neither backend runs in prod today. When one is turned on, `values.yaml` documents a single command: `kubectl -n travel-agent create secret generic travel-agent-db-parlant --type=kubernetes.io/basic-auth --from-literal=username=parlant --from-literal=password=$(openssl rand -hex 32)`. Use hex, so the password is URL-safe.
- **Annotations on the Cluster:** `helm.sh/resource-policy: keep` and `tilt.dev/down-policy: keep`. Neither `helm uninstall` nor `tilt down` drops the data.

### Chart: values
```yaml
postgres:
  enabled: false                # homelab travel-agent.yaml + values-dev.yaml: true
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:18
  storageClass: ''              # homelab: longhorn-workers; dev: longhorn
  size: 5Gi
  resources:
    requests: { cpu: 25m, memory: 128Mi }
    limits: { memory: 512Mi }
  podMonitor:
    enabled: false              # homelab: true (dev inherits it from the homelab values, which is fine)
  isolation:
    rejectOthers: true          # the trailing `host all all all reject` pg_hba line

# Don't turn the backends' Postgres on in prod until their retention follow-up lands:
# their checkpoints and sessions hold whole guest conversations with no expiry.
langgraph:
  postgres:
    enabled: false              # values-dev: true. Role password Secret: travel-agent-db-langgraph
parlant:
  postgres:
    enabled: false              # values-dev: true. Role password Secret: travel-agent-db-parlant
```
The API's database is part of the cluster and has no separate flag. When `postgres.enabled` is set, the API uses it. The template fails with a clear message if `<component>.postgres.enabled` is set without `postgres.enabled`.

### Chart: templates
- **`templates/postgres.yaml` (new):** renders the `Cluster` and, optionally, a `PodMonitor`:
  - Cluster: the values above, plus `affinity.nodeSelector` from the chart's global `nodeSelector`, and the `pg_hba` lines for the enabled components.
  - PodMonitor: `cnpg.io/cluster: <cluster>`, `cnpg.io/podRole: instance`, port `metrics`.

  It also renders a `DatabaseRole` and a `Database` for each enabled backend.
- **`_helpers.tpl`:**
  - `travel-agent.postgresClusterName` returns `<fullname>-db`.
  - `travel-agent.deployment` gains an optional `secretEnv` list (`{name, secret, key}` → `valueFrom.secretKeyRef`). Secret entries render *before* the literal `env`, so literal values can use `$(VAR)` expansion.
  - `travel-agent.postgresCa` returns the CA volume and mount (`<cluster>-ca`, item `ca.crt` → `/etc/postgres-ca/ca.crt`, read-only).
- **Connection env**, one URL per service:

  | Service | Env | Source |
  |---|---|---|
  | API | `DATABASE_URL` | `secretKeyRef travel-agent-db-app/uri` |
  | LangGraph | `LANGGRAPH_DB_PASSWORD` → `LANGGRAPH_DATABASE_URL=postgresql://langgraph:$(LANGGRAPH_DB_PASSWORD)@<cluster>-rw:5432/langgraph` | `secretKeyRef travel-agent-db-langgraph/password` |
  | Parlant | `PARLANT_DB_PASSWORD` → `PARLANT_DATABASE_URL=postgresql://parlant:$(PARLANT_DB_PASSWORD)@<cluster>-rw:5432/parlant` | `secretKeyRef travel-agent-db-parlant/password` |

  Each service also gets `<PREFIX>DATABASE_SSL_ROOT_CERT=/etc/postgres-ca/ca.crt` and the CA mount. The services build their TLS options in code rather than editing the URL.

### API: the database module
New dependencies:
- **`dependencies`:** `drizzle-orm`, `pg`.
- **`devDependencies`:** `drizzle-kit`, `@types/pg`, `@electric-sql/pglite`.

**`src/database/database.module.ts`** (new, `@Global()`) provides `DATABASE: Database | null`, where `type Database = NodePgDatabase<typeof schema>`.
- It's `null` when `DATABASE_URL` is unset.
- Pool: `new Pool({ connectionString, max: 5, ssl })`, with `ssl = DATABASE_SSL_ROOT_CERT ? { ca: readFileSync(path), rejectUnauthorized: true } : undefined`.
- **TLS rule** (a shared `sslOptions(url, caPath)` helper, unit tested in each service):
  - a CA path is given: verify against it, with host-name checking on;
  - no CA, and the host is `localhost`/`127.0.0.1`: no TLS (for local runs);
  - no CA and any other host: refuse to start;
  - an `sslmode` in the URL is rejected, because node-postgres lets it override the `ssl` option.
- `Database` is typed as Drizzle's driver-neutral base, `PgDatabase<PgQueryResultHKT, typeof schema>`, so the same store code accepts `node-postgres` in production and PGlite in tests.
- The pool's `error` handler logs `err.message` only.
- `onApplicationShutdown` ends the pool.

**`src/database/migrate.ts`:** `runMigrations(pool)`.
- It takes `pg_advisory_lock(hashtext('travel-agent-api-migrations'))` on a dedicated client.
- It runs `migrate()` from `drizzle-orm/node-postgres/migrator`, with the migrations folder resolved from `import.meta.url`.
- It unlocks in `finally`.
- The first connection is retried with backoff (1 s doubling to 15 s) for up to **4 minutes**, which covers a first cluster bootstrap and stays inside the 5-minute startup probe and `helm --wait`.
- The `DATABASE` async provider factory awaits `runMigrations`, so Nest doesn't listen until the schema is current.

**`src/database/schema/intake.ts`:**
```ts
export const intake = pgSchema('intake');
export const conversations = intake.table('conversations', {
  conversationId: text('conversation_id').primaryKey(),
  keyHash: bytea('key_hash').notNull(),          // customType: fromDriver = (v) => Buffer.from(v)
  threadId: text('thread_id').notNull().unique(),
  parlantSessionId: text('parlant_session_id'),  // set once, by ParlantService
  identity: jsonb('identity').$type<GuestIdentity>().notNull(),
  trip: jsonb('trip').$type<TripBriefProps>(),
  draft: jsonb('draft').$type<TripBriefProps>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('conversations_last_seen_at_idx').on(t.lastSeenAt)]);
```
- `bytea` is normalized to `Buffer` on read, because PGlite returns a `Uint8Array` and `pg` returns a `Buffer`. The key check (`timingSafeEqual`) gets the same type on both drivers.
- `schema/index.ts` re-exports each area.
- `apps/api/drizzle.config.ts`: `{ dialect: 'postgresql', schema: './src/database/schema/index.ts', out: './drizzle', schemaFilter: ['intake'] }`.
- `npm run db:generate -w @travel-agent/api` writes committed SQL to `apps/api/drizzle/`. The runtime image copies that folder.
- `src/database/README.md` states the convention:
  - one `pgSchema` and one file per bounded area;
  - foreign keys across schemas only when written down;
  - generated migrations are never edited after they're merged.

### API: the intake store
```ts
// src/intake/intake.store.ts
export interface IntakeStore {
  get(conversationId: string): Promise<IntakeRecord | undefined>;
  /** Inserts only if absent; false when the id was already claimed. */
  claim(conversationId: string, record: IntakeRecord): Promise<boolean>;
  update(conversationId: string, patch: Partial<Pick<IntakeRecord, 'identity' | 'trip' | 'draft'>>): Promise<void>;
  /** Bumps last_seen_at, at most once an hour per record. */
  touch(conversationId: string): Promise<void>;
  /** Sets the Parlant session only if none is set yet; returns the one that won. */
  setParlantSession(conversationId: string, sessionId: string): Promise<string>;
  /** Deletes records not seen since `before`, then the oldest beyond `max`; returns the count. */
  prune(before: Date, max: number): Promise<number>;
}
export const INTAKE_STORE = Symbol('INTAKE_STORE');
```
The two implementations:
- **`MemoryIntakeStore`:** today's `Map` with its LRU cap, plus `prune`.
- **`PostgresIntakeStore`:**
  - **`claim`:** `insert … onConflictDoNothing().returning(...)`.
  - **`update`:** sets the patch, `updated_at = now()` and `last_seen_at = now()`.
  - **`touch`:** `update … set last_seen_at = now() where conversation_id = $1 and last_seen_at < now() - interval '1 hour'`.
  - **`setParlantSession`:** `update … set parlant_session_id = $2 where conversation_id = $1 and parlant_session_id is null`, then reads back the stored value. A concurrent loser gets the winner's session.
  - **`get`:** a select by primary key. It parses the JSONB with the shared zod schemas. A row that fails to parse is logged by conversation id (no values) and treated as absent.
  - **`prune`:** `delete where last_seen_at < $1`, then `delete where conversation_id in (select conversation_id … order by last_seen_at desc offset $max)`.
  - **`claim`** also runs the row-cap delete when the insert succeeds, at most once a minute, so a flood of claims can't fill the volume between hourly prunes.

`IntakeModule` picks between them: `db ? Postgres : Memory`. With memory it logs `warn('DATABASE_URL is not set: intake records are in memory and lost on restart')`.

`IntakeService` keeps the key hashing and `timingSafeEqual`. Its methods become `async`:
- **`setIdentity`** runs `get`:
  - if the record exists: `authorize`, then `update`;
  - if not: mint the key and `threadId`, then `claim`. If the claim loses a race, it calls `authorize` against the winner's record, which throws 403.
- **`authorize`** calls `touch` after a successful key check, so chat turns count as activity.
- **Retention:**
  - `prune(now - INTAKE_RETENTION_DAYS days, INTAKE_MAX_CONVERSATIONS)` runs at startup, then hourly on an `unref`'d interval.
  - The default is **7 days**; the minimum is 1.
  - Errors are logged and never thrown, and it logs `intake pruned count=<n>`.
- **Call sites** add `await` and become `async` handlers.

**Health:** the liveness probe stays free of the database, so a Postgres blip doesn't restart the API. There's no public DB health route (`/api` is all on the public ingress). Database health comes from CNPG's metrics and the alerts added in step 10.

### API: Parlant sessions on the intake record
`ParlantService` (`apps/api/src/parlant/parlant.service.ts`) maps conversation ids to Parlant session ids in an in-memory, 10,000-entry `Map`, and doesn't know about claims. Once intake rows are pruned while the API runs, a reclaimed conversation id would pick up the earlier guest's session and could stream its events through `GET /parlant/:id/events`.

The fix:
- `sessionFor(conversationId)` reads `parlant_session_id` from the intake record. If it's unset, it creates the session and stores it with `setParlantSession`.
- The in-process `Map` stays, but only to deduplicate concurrent creates. It's keyed by the record's `threadId`, so a new claim never reuses an old promise.
- The Parlant customer id stays the conversation id, which the agent's tools use to find the intake record. The customer holds no guest data (its name is the id). A reclaimed id reuses that customer, but gets a new session.
- `forget` clears `parlant_session_id` along with the `Map` entry.
- Pruning the record deletes the mapping with it. As a side benefit, Parlant conversations now survive an API restart.

### LangGraph: the Postgres checkpointer
- **`config.ts`:**
  - `LANGGRAPH_CHECKPOINTER: z.enum(['sqlite','memory','postgres'])`;
  - `LANGGRAPH_DATABASE_URL?`;
  - `LANGGRAPH_DATABASE_SSL_ROOT_CERT?`;
  - a `superRefine`: `postgres` requires the URL.
- **`checkpointer.ts`:** `createCheckpointer(config): Promise<BaseCheckpointSaver>`.
  - For `postgres`: a `pg.Pool({ max: 5, ssl })` using the same TLS rule as the API; then `new PostgresSaver(pool)`; then `await setup()`. The first connection is retried the same way (backoff, up to 4 minutes).
  - The pool closes on `SIGTERM`.
- **`main.ts`:** `checkpointer: await createCheckpointer(config)`.
- **Dependencies:** add `@langchain/langgraph-checkpoint-postgres@^1.1.4` and `pg`. Keep `-sqlite`.
- **Chart:** sets `LANGGRAPH_CHECKPOINTER=postgres` when `langgraph.postgres.enabled`.

### Parlant: `PostgresDocumentDatabase`
**`apps/parlant/travel_agent/postgres_db.py`** (new) is a port of `parlant/adapters/db/sqlite.py` to **asyncpg**, against the same public ABCs. It has no dependency on SQLite internals.

**Tables** (created by `__aenter__` with `IF NOT EXISTS`, in the `parlant` database's `public` schema):
```sql
CREATE TABLE IF NOT EXISTS parlant_collections (name text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS parlant_documents (
  collection_name text NOT NULL,
  id text NOT NULL,
  creation_utc text,
  document jsonb NOT NULL,
  PRIMARY KEY (collection_name, id)
);
CREATE INDEX IF NOT EXISTS parlant_documents_creation_idx ON parlant_documents (collection_name, creation_utc, id);
CREATE INDEX IF NOT EXISTS parlant_documents_doc_idx ON parlant_documents USING gin (document jsonb_path_ops);
```

**`PostgresDocumentDatabase(dsn, ssl_root_cert=None, logger=None)`:**
- It's an async context manager that owns an `asyncpg.create_pool(min_size=1, max_size=5, ssl=ctx, init=...)`.
  - `ctx` is an `ssl.SSLContext` loaded with the CA, with host-name checking on. The same fail-closed rule as the Node services applies: with no CA, it only connects to `localhost` (with `ssl=False`), and otherwise refuses to start. That avoids asyncpg's default `prefer`, which encrypts without verifying.
  - `init` registers a `jsonb` codec (`set_type_codec('jsonb', encoder=json.dumps, decoder=json.loads, schema='pg_catalog')`) on each connection. Without it, asyncpg returns `jsonb` as `str`.
- It implements `create_collection`, `get_collection`, `get_or_create_collection` and `delete_collection` the same way the SQLite adapter does, using `INSERT … ON CONFLICT DO NOTHING` and caching collections in a dict.

**`PostgresDocumentCollection[TDocument]`:**
- **Document loaders.** Each collection keeps the `schema` and `document_loader` it was given, and runs the loader on *every* read path (`find`, `find_one`, `update_one`, `delete_one`) before `matches_filters`, exactly like the SQLite adapter. Loaders can rewrite fields (for example `CustomerDocumentStore` fills in a missing `kind`), so filters always match against loaded documents.
- **Filter pushdown (A9).** Only scalar (string, number, bool) `$eq` terms on an allowlist of fields that loaders don't rewrite are pushed down. The allowlist defaults to `{"id", "session_id"}` and is a constructor argument. `_sql_prefilter(filters)` pulls out those terms at the top level or inside a top-level `$and`, and turns them into `document @> $n::jsonb`, which the GIN index serves. `null`, lists, objects and missing fields are never pushed down.
  - `id` equality uses the primary key.
  - The rows that come back are *always* run through `matches_filters(filters, doc)` as well, so the result is correct even when a filter can't be pushed down. It's just slower in that case.
- **`find`:** prefilter, then `matches_filters`, then the same ASC/DESC sort on `(creation_utc, id)`, cursor filter, `limit` and `has_more`/`next_cursor` logic as SQLite, with `total_count` before paging.
  - The sort and cursor helpers are copied over, not imported from the SQLite module.
- **`find_one`:** the same path, first match after the optional sort.
- **`insert_one`:** `ensure_is_total`, then `INSERT … ON CONFLICT (collection_name, id) DO UPDATE SET document = EXCLUDED.document, creation_utc = EXCLUDED.creation_utc`. That matches SQLite's `INSERT OR REPLACE`.
- **`update_one`:**
  - **With `metadata_revision: {$eq: r}` in the filters:** a single statement, `UPDATE … SET document = document || $patch::jsonb WHERE collection_name=$1 AND id=$2 AND document->'metadata_revision' = to_jsonb($r)`. A rowcount of 0 means `matched_count=0`. This keeps the compare-and-swap atomic across connections and pods, and patches only the requested top-level fields.
  - **Otherwise:** read, merge, write, inside `SELECT … FOR UPDATE` in a transaction.
  - **`upsert`** falls through to `insert_one`, as in SQLite.
- **`delete_one`:** find, then delete by primary key.
- **`ensure_indexes`:** a no-op, like SQLite. The GIN index covers equality lookups.
- **Locking:** an in-process `ReaderWriterLock` per collection, kept from the SQLite adapter, plus the row-level guarantees above.
- **Logging:** never logs document contents, only collection names and ids.

**`main.py`** reads `PARLANT_DATABASE_URL`:
```python
async with AsyncExitStack() as stack:
    session_store = customer_store = "local"
    if dsn := os.environ.get("PARLANT_DATABASE_URL"):
        db = await stack.enter_async_context(
            PostgresDocumentDatabase(dsn, os.environ.get("PARLANT_DATABASE_SSL_ROOT_CERT")))
        session_store = await stack.enter_async_context(
            SessionDocumentStore(db, allow_migration=MIGRATE, collections_prefix="sessions"))
        customer_store = await stack.enter_async_context(
            CustomerDocumentStore(IdGenerator(), db, allow_migration=MIGRATE, collections_prefix="customers"))
    async with p.Server(models=..., session_store=session_store, customer_store=customer_store,
                        migrate=MIGRATE, hot_reload=False) as server:
        ...
```
- `MIGRATE = False`, the same as `p.Server`'s default (`sdk.py:3076`), which `local` passes to its stores as `allow_migration`. So a Parlant upgrade that changes a store's schema fails loudly with `MigrationRequired` on both backends, rather than rewriting documents silently. Running a migration is a deliberate step: start once with `migrate=True`.
- **Dependencies:** `pyproject.toml` adds `asyncpg>=0.30`, then `uv lock`.
- **Chart:**
  - When `parlant.postgres.enabled`, the chart sets `PARLANT_DATABASE_URL` and the CA.
  - `PARLANT_HOME` stays, on an `emptyDir` once the PVC goes (step 9). It holds only `indexing_cache.json` and logs, which are rebuilt on restart. The cost is one round of re-embedding guidelines at startup.

**Reuse beyond this project.** The module only imports `parlant.core.persistence.*` and `asyncpg`, so it can be lifted into its own package later (a follow-up). `docs/agent-frameworks.md` records that the persistence ABCs are internal to `parlant.core`, so they could change in a minor release. That's the upgrade risk.

### Tilt
- **`dev_secret`-style Secrets** `travel-agent-db-langgraph` and `travel-agent-db-parlant` (basic-auth) are built from `.env` whenever the matching `postgres.enabled` is on in dev. That's always the case: the roles exist even when the backend isn't selected.
- **`k8s_resource` grouping:**
  - `travel-agent-db:cluster` goes into `travel-agent-infra`;
  - each backend's `Database` and `DatabaseRole` and its Secret go with the backend's resource when it's selected, and into infra when it isn't.
- **`values-dev.yaml`:** `postgres.enabled: true`, `postgres.storageClass: longhorn`, `langgraph.postgres.enabled: true`, `parlant.postgres.enabled: true`.
- **Env plumbing:** `.env.example` adds `LANGGRAPH_DB_PASSWORD=<generated>` and `PARLANT_DB_PASSWORD=<generated>`. Existing `.env` files need them added by hand; the Tiltfile warns, as it does for `LANGGRAPH_API_TOKEN`.
- **`turbo.json`:** `dev.passThroughEnv` adds `DATABASE_*` (`LANGGRAPH_*` and `PARLANT_*` are already there). The `test` task gains `passThroughEnv: ["TEST_DATABASE_URL", "PARLANT_TEST_DATABASE_URL"]`, so the opt-in tests also work through `npm test`.
- **Migrations in the dev loop:** the API's `live_update` adds `sync('apps/api/drizzle', '/repo/apps/api/drizzle')`, so a newly generated migration reaches the dev pod along with the schema change in `src/`.

### Homelab Inkeep: one `inkeep-db` cluster
**New `../../homelab/apps/inkeep/postgres.yaml`:**
```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: inkeep-db, namespace: inkeep }
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:18
  enableSuperuserAccess: false
  bootstrap:
    initdb:
      database: inkeep_agents
      owner: inkeep
      import:
        type: microservice
        databases: [inkeep_agents]
        source: { externalCluster: inkeep-postgres }
  externalClusters:
    - name: inkeep-postgres
      connectionParameters: { host: inkeep-postgres, user: appuser, dbname: inkeep_agents, sslmode: disable }
      password: { name: inkeep-secrets, key: POSTGRES_PASSWORD }
  storage: { storageClass: longhorn-workers, size: 12Gi }
  affinity: { nodeSelector: { kubernetes.io/arch: amd64 } }
  resources: { requests: { cpu: 50m, memory: 192Mi }, limits: { memory: 1Gi } }
---
apiVersion: postgresql.cnpg.io/v1
kind: DatabaseRole
metadata: { name: inkeep-db-spicedb, namespace: inkeep }
spec: { cluster: { name: inkeep-db }, name: spicedb, login: true, passwordSecret: { name: inkeep-db-spicedb }, databaseRoleReclaimPolicy: retain }
---
apiVersion: postgresql.cnpg.io/v1
kind: Database
metadata: { name: inkeep-db-spicedb, namespace: inkeep }
spec: { cluster: { name: inkeep-db }, name: spicedb, owner: spicedb, databaseReclaimPolicy: retain }
---
# PodMonitor as in the template
```
- **Isolation**, as in the travel-agent clusters: `spec.postgresql.pg_hba` gets `host inkeep_agents inkeep all scram-sha-256` (`hostssl` once Inkeep's TLS follow-up lands), `hostssl spicedb spicedb all scram-sha-256`, then `host all all all reject`.
- **Secrets: `generate-inkeep-secret.sh` is not re-run.** Re-running it with `FORCE=1` regenerates *every* Inkeep secret: the Doltgres password, the JWT keys, the bypass secret the travel-agent API uses, and the old DB passwords that the import and the rollback depend on. Instead, step 11:
  - creates the `inkeep-db-spicedb` basic-auth Secret on its own (`openssl rand -hex 32`);
  - saves the current `INKEEP_AGENTS_RUN_DATABASE_URL` and `SPICEDB_DATASTORE_CONN_URI` values to a local file outside both repos (`chmod 600`), for the rollback;
  - `kubectl patch`es just those two keys in the live `inkeep-secrets`: the run DB URL becomes the value of `inkeep-db-app/uri`, and the SpiceDB URI becomes `postgres://spicedb:<pw>@inkeep-db-rw:5432/spicedb?sslmode=require`.

  Patching the Secret (instead of overriding env per container) means every controller that loads `inkeep-secrets`, including the manage UI, sees the new values. There's one source of truth. The gitignored `inkeep-secret.yaml` is refreshed from the live Secret afterwards, and the script itself only changes in step 12, for fresh installs.
- **SpiceDB data** moves by dump and restore (step 11), because the bootstrap import can only pull from one source server.
- **Why one cluster:** this follows the "not one per backend" rule. Inkeep is a single app with a single install, so it gets a single cluster.

### Alternatives considered
| Option | Pros | Cons | Why not |
|---|---|---|---|
| A cluster per service | The operator generates every credential | More Postgres pods | The user wants one cluster per environment (rev 3) |
| One database, a schema per service, one shared role | No role Secrets at all | Every service can read the API's guest data | Least privilege is worth two small Secrets |
| A secret-generator controller (mittwald or external-secrets `Password`) | No hand-made Secrets, under Tilt and Helm alike | Another homelab operator | Heavier than needed for two roles (user, rev 4) |
| `DatabaseRole.clientCertificate` instead of passwords | No passwords | `pg_hba` cert rules; pools read cert files once, so renewals need a reload | A new pattern; revisit if more services join |
| Parlant: custom `SessionStore` + `CustomerStore` (19 + 9 methods) | Can use a schema shaped for the domain | It's coupled to Parlant's domain model and breaks more easily on upgrades | A `DocumentDatabase` (about 10 methods) reuses Parlant's own stores and migrations |
| Parlant: FerretDB (the MongoDB protocol on Postgres) and `mongodb://` | No adapter code | One more service, and a non-standard Postgres image with the DocumentDB extension | More to run than to write |
| Kysely, plain `pg` or TypeORM in the API | — | Hand-written migrations and types, or (TypeORM) friction with ESM and its CLI | Drizzle (rev 2) |
| Migrations as a Helm hook or a Job | Off the startup path | Tilt doesn't run hooks | An advisory lock is enough with one replica |

## Implementation steps

### 1. Chart: the cluster, the per-backend database and role, secret env and the CA helper
- Files:
  - `deploy/helm/travel-agent/values.yaml` (modify): `postgres.*`, `langgraph.postgres.*` and `parlant.postgres.*`, with comments, including the prod `kubectl create secret` command.
  - `deploy/helm/travel-agent/templates/_helpers.tpl` (modify): `postgresClusterName`, `postgresCa`, and `secretEnv` in `deployment`.
  - `deploy/helm/travel-agent/templates/postgres.yaml` (new).
  - `deploy/helm/travel-agent/templates/NOTES.txt` (modify).
- Changes: as in the Design section. The services aren't wired up yet.
- Verify:
  - `helm lint`.
  - `helm template t deploy/helm/travel-agent` renders no CNPG objects.
  - With `--set postgres.enabled=true,langgraph.postgres.enabled=true,parlant.postgres.enabled=true,postgres.podMonitor.enabled=true` it renders 1 Cluster (with four `pg_hba` lines), 2 DatabaseRoles, 2 Databases and 1 PodMonitor.
  - With `parlant.postgres.enabled=true` alone, it fails with the clear message.
  - Pipe the output into `kubectl apply --dry-run=server -n travel-agent-dev -f -`.

### 2. API: the database module, schema and migrations (no callers yet)
- Files:
  - `apps/api/package.json` (dependencies, `db:generate`, `db:check`);
  - `apps/api/drizzle.config.ts`;
  - `apps/api/src/database/{database.module.ts,migrate.ts,schema/index.ts,schema/intake.ts,README.md}`;
  - `apps/api/drizzle/*` (generated);
  - `apps/api/src/app.module.ts`;
  - `apps/api/Dockerfile` (`runtime`: `COPY --from=build /repo/apps/api/drizzle apps/api/drizzle`);
  - `turbo.json` (`DATABASE_*`);
  - `Tiltfile` (the `apps/api/drizzle` sync).
  - `apps/api/src/database/migrate.spec.ts`: on PGlite, the migrations apply twice and the second run is a no-op; `intake.conversations` exists.
  - `apps/api/src/database/run-migrations.int.spec.ts` (opt-in on `TEST_DATABASE_URL`): `runMigrations(pool)` against real Postgres, including two concurrent calls (the advisory lock lets one through at a time, and both succeed).
  - `apps/api/src/database/ssl-options.spec.ts`: the TLS rule's four cases.
  - A spec for the unreachable-DB path: with a short retry budget, the factory throws after its retries, with a message that names no credentials.
- Verify:
  - `npm run db:check -w @travel-agent/api`, `npm test -w @travel-agent/api`, `npm run typecheck`;
  - `npm run dev` with no `DATABASE_URL` still starts.

### 3. API: the intake store behind an interface (memory only)
- Files:
  - `apps/api/src/intake/{intake.store.ts,intake.memory-store.ts,intake.store.contract.ts}` (new);
  - `intake.service.ts`, `intake.module.ts`, `intake.controller.ts`, `chat/chat.controller.ts`, `parlant/parlant.controller.ts`, `langgraph/langgraph.controller.ts` (async);
  - the specs and `test/*.e2e-spec.ts`;
  - `intake.service.spec.ts`: claim, then authorize; 403 on a wrong key; 404 on an unknown id; `saveDraft` 404; prune.
- Changes: a pure refactor; behavior is the same as today.
- Verify: `npm test -w @travel-agent/api` and `npm run test:e2e -w @travel-agent/api`.

### 4. API: the Postgres intake store, retention and Parlant sessions on the record
- Files:
  - `apps/api/src/intake/intake.postgres-store.ts` (new);
  - `intake.module.ts` (the factory and the warning);
  - `intake.service.ts` (prune, `touch` in `authorize`, `INTAKE_RETENTION_DAYS` default 7, `INTAKE_MAX_CONVERSATIONS` default 10,000);
  - `intake.postgres-store.spec.ts`: PGlite plus the real migrations; the contract suite; invalid `identity` reads as absent and logs; `update` bumps `updated_at` and `last_seen_at`; `touch` is throttled; `keyHash` comes back as a `Buffer`; prune by age and by the row cap.
  - `intake.postgres-store.int.spec.ts` (opt-in on `TEST_DATABASE_URL`): two concurrent `claim`s give exactly one `true`; two concurrent `setParlantSession`s return the same session. PGlite runs one statement at a time, so it can't test these races.
  - `apps/api/src/parlant/parlant.service.ts` and its spec (modify): sessions on the intake record. The spec covers claim → session A, prune, reclaim → a new session B, plus the session surviving a new `ParlantService` instance (that is, an API restart).
- Verify:
  - `npm test -w @travel-agent/api`, then the same with `TEST_DATABASE_URL` set to the throwaway Postgres below.
  - Manually: `docker run --rm -e POSTGRES_PASSWORD=x -p 5433:5432 postgres:18` with `DATABASE_URL=postgres://postgres:x@localhost:5433/postgres npm run dev -w @travel-agent/api`. Go through intake with `curl`, restart the API, and check the key still authorizes. `psql` shows the row.

### 5. Chart and Tilt: wire the API to the dev cluster
- Files:
  - `templates/api.yaml` (`DATABASE_URL` via `secretEnv`, the CA, when `postgres.enabled`);
  - `values-dev.yaml` (`postgres.enabled: true`, `postgres.storageClass: longhorn`);
  - `Tiltfile` (`travel-agent-db:cluster` → `travel-agent-infra`);
  - `README.md` ("Database" section: the cluster, its databases, `kubectl cnpg status travel-agent-db`, `npm run db:generate`, the local fallback, and wiping dev with `kubectl -n travel-agent-dev delete cluster travel-agent-db`).
- Verify:
  - `tilt up`. The cluster becomes healthy, and the API logs that the migrations were applied.
  - Do an intake at https://travel-dev.honnei.house, delete the API pod, and the conversation continues.
  - `kubectl -n travel-agent-dev exec travel-agent-db-1 -- psql -U postgres -c "select usename, ssl from pg_stat_ssl join pg_stat_activity using (pid) where usename='api'"` shows `t`.

### 6. LangGraph: the Postgres checkpointer
- Files:
  - `apps/langgraph/package.json`;
  - `src/{config.ts,checkpointer.ts,main.ts}`;
  - `config.spec.ts`;
  - `checkpointer.spec.ts` (PGlite socket round trip, or opt-in on `TEST_DATABASE_URL`);
  - `templates/langgraph.yaml` (env and CA when `langgraph.postgres.enabled`);
  - `values-dev.yaml` (`langgraph.postgres.enabled: true`);
  - `Tiltfile` (`basic_auth_secret('travel-agent-db-langgraph', 'langgraph', 'LANGGRAPH_DB_PASSWORD')`, and object grouping);
  - `.env.example`.
- Verify:
  - `npm test -w @travel-agent/langgraph`.
  - `tilt up -- --chat-backend=langgraph`: chat into planning; restart the LangGraph pod; the conversation resumes.
  - `psql -d langgraph -c 'select count(*) from checkpoints'` is > 0.
  - Switch to `inkeep` and back; the conversation still resumes.
  - **Isolation:** `kubectl -n travel-agent-dev exec deploy/travel-agent-langgraph -- node -e "…connect as langgraph to db api…"` fails with a `pg_hba` reject. Any one-liner with `pg` will do.

### 7. Parlant: `PostgresDocumentDatabase` and its contract tests
- Files:
  - `apps/parlant/travel_agent/postgres_db.py` (new).
  - `apps/parlant/pyproject.toml` and `uv.lock` (`asyncpg`).
  - `apps/parlant/tests/test_document_database_contract.py` (new): one parametrized suite run against `TransientDocumentDatabase`, `SQLiteDocumentDatabase` (tmp path) and `PostgresDocumentDatabase`. The Postgres runs are skipped unless `PARLANT_TEST_DATABASE_URL` is set. The suite covers:
    - collection create/get/delete semantics, including `get_collection` on a missing collection raising `ValueError`;
    - insert-or-replace;
    - `find` with `$eq`/`$ne`/`$in`/`$and`/`$or`, ASC/DESC, `limit`, cursor paging and `total_count`;
    - `update_one` with and without `upsert`;
    - the `metadata_revision` compare-and-swap: two concurrent updates with the same revision give exactly one match;
    - `delete_one`;
    - `$eq` on `null`, on a list value and on a missing field (all must match the SQLite oracle, which proves they aren't pushed down wrongly);
    - a collection with a `document_loader` that adds a field, then a filter on that field.
  - `apps/parlant/tests/test_postgres_stores.py` (new, also opt-in): `SessionDocumentStore` and `CustomerDocumentStore` on the adapter. Create a customer, create a session, append events, list events by session, read them back after reopening the database.
- Verify:
  - `uv run pytest` passes, with the Postgres cases skipped.
  - `docker run --rm -e POSTGRES_PASSWORD=x -p 5433:5432 postgres:18`, then `PARLANT_TEST_DATABASE_URL=postgresql://postgres:x@localhost:5433/postgres uv run pytest`: all pass.
  - `uv run ruff check`.
  - Log the filters seen during `test_postgres_stores.py` and confirm that A9 holds for event lookups.

### 8. Parlant: wire it to the dev cluster
- Files:
  - `apps/parlant/main.py` (the `AsyncExitStack` setup, plus the docstring's env list: `PARLANT_DATABASE_URL`, `PARLANT_DATABASE_SSL_ROOT_CERT`);
  - `templates/parlant.yaml` (env and CA when `parlant.postgres.enabled`);
  - `values-dev.yaml` (`parlant.postgres.enabled: true`);
  - `Tiltfile` (`basic_auth_secret('travel-agent-db-parlant', 'parlant', 'PARLANT_DB_PASSWORD')`, and grouping);
  - `.env.example`.
- Verify:
  - `tilt up -- --chat-backend=parlant`: chat through intake into planning.
  - Delete the Parlant pod. The conversation continues and the web app doesn't show `SESSION_GONE_MESSAGE`.
  - `psql -d parlant -c "select collection_name, count(*) from parlant_documents group by 1"` shows the `sessions*` and `customers*` collections.

### 9. Retire the backend PVCs in dev
- Files:
  - `values-dev.yaml`: `langgraph.persistence.enabled: false` and `parlant.persistence.enabled: false`.
  - `values.yaml`: update the `persistence` comments to say the PVCs are only for running without Postgres.
- Changes: once steps 6 and 8 have been verified, delete the PVCs by hand: `kubectl -n travel-agent-dev delete pvc travel-agent-langgraph travel-agent-parlant`.
- Verify:
  - `helm template` with the dev values renders no backend PVCs.
  - All three `--chat-backend` values still work.

### 10. Prod: the API database (homelab repo)
- Files:
  - `../../homelab/helm-values/travel-agent.yaml`: `postgres.enabled: true`, `postgres.storageClass: longhorn-workers`, `postgres.podMonitor.enabled: true`.
  - `../../homelab/apps/cloudnative-pg/cluster-template.yaml`: image `:18`, and a note that the travel-agent chart declares its own cluster.
  - `../../homelab/README.md`.
  - `../../homelab/apps/cloudnative-pg/alerts.yaml` (new): a `PrometheusRule` (kube-prometheus-stack) with `CNPGInstanceDown` (`cnpg_collector_up == 0` for 5m) and `CNPGVolumeAlmostFull` (the `kubelet_volume_stats` used-to-capacity ratio of a `cnpg.io/cluster` PVC above 80% for 15m). It covers every CNPG cluster, Inkeep's and Mealie's included.
- Changes: this is the first time prod has a stateful dependency. During a node drain or a Longhorn rebuild, intake returns 5xx until the instance is back. That's accepted, with one instance.
- Verify:
  - `npm run deploy`.
  - `kubectl -n travel-agent get cluster travel-agent-db` is healthy.
  - Prod intake survives `kubectl -n travel-agent rollout restart deploy/travel-agent-api`.
  - The CNPG Grafana dashboard lists the cluster, and Prometheus shows both alert rules loaded.

### 11. Homelab Inkeep: rehearse, then cut over to `inkeep-db`
- Files:
  - `../../homelab/apps/inkeep/postgres.yaml` (new);
  - `../../homelab/helm-values/inkeep.yaml` (only the header's new prereq: no env overrides, because the Secret is patched);
  - `../../homelab/README.md`.
- **Rehearsal** (before the real window; Inkeep keeps running):
  1. On the old run DB, record `\dx` (extensions) and `\du` (roles), and confirm every extension exists in `ghcr.io/cloudnative-pg/postgresql:18`.
  2. Apply a copy of the Cluster named `inkeep-db-test`, with the same import and the same `pg_hba`.
  3. Point a one-off `agents-migrate` pod at `inkeep-db-test-app/uri` (as the non-superuser owner): it must finish without errors.
  4. Restore SpiceDB into a `spicedb` database on `inkeep-db-test` (the pipe below), then run a one-off `spicedb migrate head` and `spicedb serve` against it as the `spicedb` role, and do one read.
  5. Delete `inkeep-db-test`. If any step failed, stop and revise this plan.
- **Cutover runbook:**
  1. **Longhorn backup:** take a Longhorn backup of `data-inkeep-postgres-0` and `data-inkeep-spicedb-postgres-0` (Longhorn UI, or a `Backup` CR per volume). That's the only extra copy: these aren't prod systems yet.
  2. Save the current `INKEEP_AGENTS_RUN_DATABASE_URL` and `SPICEDB_DATASTORE_CONN_URI` from `inkeep-secrets` to a `chmod 600` local file.
  3. Note the replica counts (`kubectl -n inkeep get deploy`), then scale `inkeep-api` and `inkeep-spicedb` to 0.
  4. Create the `inkeep-db-spicedb` Secret, `kubectl apply -f apps/inkeep/postgres.yaml`, and wait: `kubectl -n inkeep wait cluster/inkeep-db --for=condition=Ready --timeout=10m`. Check that `kubectl -n inkeep get database,databaserole` both show applied.
  5. **Restore SpiceDB** through local sockets, so no password reaches a pod spec or shell history:
     ```
     kubectl -n inkeep exec inkeep-spicedb-postgres-0 -- pg_dump -Fc -U spicedb spicedb \
       | kubectl -n inkeep exec -i inkeep-db-1 -c postgres -- pg_restore --no-owner --no-acl --role=spicedb -U postgres -d spicedb
     ```
     Wait for `kubectl -n inkeep get database inkeep-db-spicedb` to show applied first: its first attempt races the role's creation, and the operator retries within about 30 s.
  5b. **Repair SpiceDB's transaction IDs** (found in the rehearsal). SpiceDB's Postgres datastore decides what's visible by transaction ID (`relation_tuple.created_xid`). Restored rows keep the old server's IDs (up to about 340,000), which are ahead of the new server's counter, so SpiceDB can't see them: the rehearsal read 0 of the 4 `project` relationships. Run SpiceDB's own repair against the new database before SpiceDB starts. It took under 2 s:
     ```
     kubectl -n inkeep run spicedb-repair --rm -i --restart=Never --image=authzed/spicedb:v1.49.2 \
       --overrides='{"spec":{"enableServiceLinks":false,"nodeSelector":{"kubernetes.io/arch":"amd64"},"containers":[{"name":"spicedb-repair","image":"authzed/spicedb:v1.49.2","args":["datastore","repair","transaction-ids"],"env":[{"name":"PW","valueFrom":{"secretKeyRef":{"name":"inkeep-db-spicedb","key":"password"}}},{"name":"SPICEDB_DATASTORE_ENGINE","value":"postgres"},{"name":"SPICEDB_DATASTORE_CONN_URI","value":"postgres://spicedb:$(PW)@inkeep-db-rw:5432/spicedb?sslmode=require"}]}]}}'
     ```
     It should log `completed revisions repair`. Then `select pg_current_xact_id()` on `inkeep-db` (database `spicedb`) must be above `select max(created_xid::text::bigint) from relation_tuple`.
  6. Spot-check row counts, old against new (`\dt` first; for example the conversations table in `inkeep_agents`, and `relation_tuple` in `spicedb`).
  7. `kubectl patch` the two keys in `inkeep-secrets` (see the Design section), then `helm upgrade --install inkeep … -f helm-values/inkeep.yaml`. Check that every Deployment is back at its noted replica count.
  8. Smoke test:
     - SpiceDB reads every relationship: compare `POST /v1/relationships/read` counts by `resourceType` (`organization`, `project`) with `relation_tuple` (port-forward `inkeep-spicedb` 8443, Bearer the preshared key);
     - log in at https://inkeep.honnei.house;
     - both travel-agent projects are visible and editable;
     - a chat on `--chat-backend=inkeep` replies;
     - `npm run agents:push:dev` succeeds.
- Verify: the smoke test; no connection errors in the `inkeep-api` or `inkeep-spicedb` logs; and, during the soak, `pg_stat_activity` on both old servers shows no client connections.
- Rollback (within the soak): patch the two saved values back into `inkeep-secrets`, `helm upgrade`, and scale back up. The old StatefulSets still hold their data, and the Longhorn backups are a second fallback.

### 12. Homelab Inkeep: remove the old databases (after 7 days)
- Files:
  - `../../homelab/helm-values/inkeep.yaml`: remove the `postgres` and `spicedb-postgres` controllers and services.
  - `../../homelab/apps/inkeep/postgres.yaml`: remove `externalClusters` and the `import` block, so nothing references the old superuser password. Re-apply it.
  - `generate-inkeep-secret.sh`: drop `POSTGRES_PASSWORD` and `SPICEDB_POSTGRES_PASSWORD`, and write the new URLs (and the `inkeep-db-spicedb` Secret) for fresh installs.
- Verify:
  - Gate: `pg_stat_activity` on the old servers still shows no clients.
  - `helm upgrade`, then the smoke test.
  - Delete `data-inkeep-postgres-0` and `data-inkeep-spicedb-postgres-0` by hand, after a final look, then delete the step 11 Longhorn backups.

### 13. Docs
- Files: `docs/agent-frameworks.md`. Under "Findings while building", add storage notes for each framework:
  - **LangGraph:** an official Postgres checkpointer, where `setup()` creates the tables.
  - **Parlant:** no Postgres store is shipped; you write a `DocumentDatabase` (about 400 lines with asyncpg, about 10 methods). The ABCs live in `parlant.core.persistence`; the SQLite reference filters in Python; we push equality filters down to JSONB containment.
  - **Inkeep:** needs two Postgres-wire DBs, one of them Doltgres (which CNPG can't host), plus SpiceDB's.

  Add a "Storage" row to the comparison table.
- Verify: read it through.

## Test plan
- **Unit (API):** the migrations on PGlite; the store contract against both stores; bad JSON, `last_seen_at` and the `touch` throttle; `Buffer` key hashes; the `IntakeService` 403/404 paths; prune by age (7-day default) and by row cap; `DATABASE` is `null` without a URL; the TLS rule; the unreachable-DB path; Parlant sessions per claim (prune then reclaim gives a new session).
- **Integration (API, opt-in on `TEST_DATABASE_URL`, real PG 18):** `runMigrations` under concurrency; `claim` and `setParlantSession` races.
- **Unit (LangGraph):** config validation; a checkpointer round trip.
- **Unit (Parlant):** the `DocumentDatabase` contract against transient, SQLite and (opt-in) Postgres, including null/list/missing `$eq` and loader-rewritten fields; the Parlant stores on Postgres (opt-in); the TLS rule.
- **E2E (API):** the existing suites pass on the memory store.
- **Chart:** `helm lint`; `helm template` (off, on, partial-failure, dev values); `kubectl apply --dry-run=server`.
- **Manual (dev):**
  - step 5: intake survives a restart, over TLS;
  - step 6: LangGraph resumes, and the isolation check rejects;
  - step 8: Parlant resumes after a pod restart.
- **Manual (prod and Inkeep):** step 10, and step 11's rehearsal and smoke test.

## Rollout & rollback
- **Order:** chart support (off) → API refactor → API on dev → LangGraph → Parlant → dev PVCs retired → prod API DB → Inkeep cutover → old Inkeep DBs removed. Each step ships alone.
- **API:**
  - Turning off `postgres.enabled` removes `DATABASE_URL`, so the API falls back to memory.
  - The Cluster stays (keep annotations), and turning it back on reconnects to the same data.
- **LangGraph / Parlant:**
  - Turning off `<component>.postgres.enabled` returns the service to SQLite. Turn `persistence` back on too to keep data across restarts.
  - The `Database` and `DatabaseRole` are `retain`, so the data stays in the cluster.
- **Inkeep:** the old StatefulSets stay for 7 days.
- **Migrations:** they only ever add. Rolling back between versions means a forward fix; Drizzle has no down migrations. Parlant's tables are created with `IF NOT EXISTS` and never altered by our code.

## Security considerations
- **Guest PII becomes durable** in three places:
  - API intake (name, contact fields, trip details);
  - LangGraph checkpoints (the conversation);
  - Parlant sessions and customers (the conversation and the customer record).

  What contains it:
  - intake is pruned after **7 days** (LangGraph and Parlant retention are follow-ups, and that gap is already there with their SQLite PVCs);
  - a database and role per service, with `pg_hba` allowing only role→own-db over `hostssl`, and a final reject;
  - `enableSuperuserAccess: false`.

  Longhorn volumes aren't encrypted at rest, which is the existing homelab posture. Conversation keys are stored only as SHA-256 hashes.
- **Credentials:**
  - The API uses the operator's `-app` Secret.
  - The LangGraph and Parlant role passwords are basic-auth Secrets: generated into `.env` for dev (the same posture as every other dev secret), and made by hand with `openssl rand -hex 32` for prod.
  - Passwords reach the pods only as `secretKeyRef` env vars. The `$(VAR)`-expanded URL is visible to anyone who can read the pod's env, which is the same exposure as today's tokens.
  - No service logs its URL. The pool error handlers log messages only.
- **TLS:**
  - The three services verify the server against `<cluster>-ca`, with host-name checks on.
  - `pg_hba` `hostssl` rejects plain-text connections for the app roles.
  - The services fail closed: with no CA, they connect only to `localhost`.
  - Inkeep: SpiceDB moves to `sslmode=require`, and `inkeep-db` gets the same role→own-db `pg_hba` isolation. Inkeep's run DB URI from `-app` has no `sslmode`, so it stays as today (follow-up).
- **Reclaimed conversation ids:** pruning makes ids claimable again while the API runs. LangGraph threads are already per claim; Parlant sessions now are too (stored on the intake record). Inkeep's history is keyed by the conversation id, which is an existing exposure this plan doesn't widen (see Follow-ups).
- **Abuse:** `PUT /intake/:id/identity` is unauthenticated for a new id. The row cap (`INTAKE_MAX_CONVERSATIONS`) and the disk alert stop a flood from filling the shared volume.
- **The Parlant adapter:**
  - all SQL is parameterized;
  - the only dynamic part is the JSONB containment value, passed as a parameter;
  - collection names are parameters, never identifiers;
  - document contents are never logged.
- **New dependencies:**
  - API: `drizzle-orm` and `pg`, plus dev-only `drizzle-kit` and `@electric-sql/pglite`;
  - LangGraph: `@langchain/langgraph-checkpoint-postgres`;
  - Parlant: `asyncpg`.

  All are widely used. Review the lockfile diffs.
- **The Inkeep import** uses the old superuser password only during bootstrap. Step 12 removes `externalClusters` from the Cluster and then drops the old keys. The SpiceDB restore uses local sockets, so no password lands in a pod spec.
- **Network:** there are no NetworkPolicies today. `pg_hba` limits which role can reach which database, but it doesn't limit which pod can try. A NetworkPolicy (only the namespace's workloads and `cnpg-system` reach `-rw`) is a follow-up.

## Performance considerations
- **API:**
  - Intake and chat requests add 1–2 single-row primary-key queries (well under 5 ms) against LLM turns that take seconds.
  - Prune runs hourly, on an index.
  - There's no performance budget in the repo.
- **LangGraph:** one checkpoint write per super-step. That's comparable to SQLite on Longhorn.
- **Parlant:**
  - The SQLite reference loads *a whole collection* per `find`. With every session's events in one collection, that grows with total history.
  - Our adapter pushes `$eq` terms down to a GIN-indexed `@>`, so event lookups by `session_id` read one session's rows.
  - Filters that can't be pushed down fall back to a full collection scan, which is no worse than today. Step 7 logs the filters so we can see whether that happens.
- **One shared instance:**
  - All three services share 25m/128Mi requests (512Mi limit) in dev. The API does a few queries per turn, LangGraph and Parlant a few writes per turn, and there's a single user.
  - Raise the limit if the CNPG dashboard shows memory pressure.
  - Dev goes from 2 PVCs to 1 cluster pod; prod adds 1 pod; Inkeep goes from 2 Postgres pods to 1.
- **Startup:**
  - The first deploy waits for the bootstrap (about 1–2 minutes), inside the startup probes.
  - Parlant re-embeds its guidelines on each restart once `indexing_cache.json` is on an `emptyDir`. That's a few Voyage calls; keep the PVC if it shows up in the logs.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The Inkeep import or the SpiceDB restore misses data, or breaks once the role isn't a superuser | Low | High (Inkeep down for both envs) | A rehearsal on `inkeep-db-test` first; a Longhorn backup of the old volumes; writes stop first; row-count checks; the old StatefulSets stay 7 days; saved Secret values for the rollback |
| Rotating Inkeep secrets by accident during the cutover | Low (once documented) | High | The runbook never re-runs `generate-inkeep-secret.sh`; it patches two keys only |
| The Parlant adapter differs subtly from SQLite (sorting, cursors, compare-and-swap) | Medium | Medium (sessions misbehave) | One contract suite run against Parlant's own SQLite and transient adapters as the oracle; the Parlant stores' integration test; manual step 8 |
| A Parlant upgrade changes the `parlant.core.persistence` ABCs | Medium | Medium | The contract suite catches it. Recorded in `agent-frameworks.md`; Parlant is pinned at 4.0.5 |
| One noisy service affects the others on the shared instance | Low | Low | A single user; separate databases; watch the CNPG dashboard |
| The `pg_hba` reject rule locks out the operator or replication (A5 wrong) | Low | High in dev (cluster unhealthy) | Verified on the dev cluster in step 5 before prod; `postgres.isolation.rejectOthers: false` removes it |
| A database outage goes unnoticed (the liveness probe is DB-free) | Medium | Medium | The CNPG alerts in step 10 |
| PGlite / pglite-socket differs from real Postgres | Low | Low | Manual runs on real PG 18 (steps 4 and 7) and the dev cluster |
| No backups | Low | High for Inkeep | As today. Follow-up: an S3 target and the barman-cloud plugin |
| The migration lock is left held after a crash | Low | Low | A session-level advisory lock is released when the connection drops |

## Open questions
None right now. Open questions 0–3 from rev 2 were answered in rev 3 (see the Decision log).

## Follow-ups
- CNPG backups (S3-compatible store, barman-cloud plugin, `ScheduledBackup`) for both travel-agent clusters and `inkeep-db`, Inkeep first.
- Retention for LangGraph checkpoints and Parlant sessions and customers, in line with intake's. It must work on their own age (checkpoint timestamps, `creation_utc`), not on intake rows: once an intake row is pruned, the link to its thread or session is gone. Required before either backend's Postgres is turned on in prod.
- Key Inkeep's conversation history by claim (for example by `threadId`) rather than by the browser's conversation id.
- Extending intake retention once guests can log in (the user, 2026-11-22).
- A Parlant `CustomerStore` over the API's own guest table, as part of the guest-data (PII) comparison.
- Lifting `PostgresDocumentDatabase` into its own package for other Parlant projects.
- NetworkPolicies for `*-db-rw`.
- TLS (`verify-full`) for Inkeep's connections.
- Other API state in Postgres (the search cap and cache, saved trips), each in its own schema.

## Decision log
- rev 1: The homelab Inkeep run DB and SpiceDB DB are in scope, with steps in the homelab repo (user).
- rev 1: The API gets a general-purpose database for the whole backend, separated by schema, with intake first (user).
- rev 2: Drizzle for the API's database layer. Nothing in the repo uses an ORM yet, and Drizzle fits ESM and PGlite tests (user).
- rev 3: Parlant is back in scope, through a `DocumentDatabase` adapter, because it's useful beyond this project (user). This reverses rev 1's "leave Parlant on SQLite".
- rev 3: One CNPG cluster per environment (prod, dev), not one per service or agent backend (user). Inside it: a database and role per service, isolated by `pg_hba` (drafter's choice, for least privilege). Inkeep gets one cluster by the same rule.
- rev 3: PG 18 for every new cluster, and the homelab template bumped to 18 (user).
- rev 3: Intake retention defaults to 7 days, to be extended once guests can log in (user).
- rev 6: Backups for the Inkeep cutover are a Longhorn backup only, deleted once the old databases are removed. The homelab systems aren't prod yet, so the extra dumps aren't worth it (user).
- rev 5: Review findings triaged by the drafter (all accepted, or deferred to Follow-ups). Drafter's call on S2: drop the public DB health route rather than harden it, since nothing uses it.
- rev 4: Keep the role passwords as they are (Tilt builds them from `.env`, made by hand in prod), rather than operator client certificates, a secret-generator controller or Helm `lookup`. Those felt heavier than needed (user). Revisit a secret generator if more roles appear.

## Changelog
- rev 6: Step 11 rehearsal done; it found the SpiceDB transaction-ID issue, and the runbook gained step 5b plus a relationship check.
- rev 6: Step 10 (prod API database) deployed and verified.
- rev 6: Steps 1–9 and 13 implemented and verified on the dev cluster; homelab files for steps 10–11 written (not applied). See Implementation notes.
- rev 6: Approved by the user (2026-11-22). Implementation started on `feat/cnpg-postgres` from `main` at e7600be.
- rev 6: Inkeep backups scaled down to a Longhorn backup of the old volumes, deleted after step 12. The off-cluster `pg_dump`s and the final dump are gone.
- rev 5: Addressed the rev 4 architecture, security and risk reviews (see the Review log). Main changes: Parlant sessions stored on the intake record; activity-based retention (`last_seen_at`) plus a row cap; a rehearsed Inkeep cutover that patches two Secret keys instead of re-running the secret script, with off-cluster dumps and a socket-based SpiceDB restore; `pg_hba` isolation on `inkeep-db`; fail-closed TLS everywhere; `allow_migration=False` for Parlant; adapter loader and pushdown rules; a 4-minute startup retry; CNPG alerts; the public DB health route dropped; test seams corrected.
- rev 4: Recorded the decision to keep role password handling as designed. No design change.
- rev 3: Parlant brought back in (the adapter design, steps 7–8, contract tests). Switched from a cluster per service to one cluster per environment, with a database and role per service, `pg_hba` isolation, and role password Secrets (Tilt from `.env`, made by hand in prod). Inkeep consolidated into one `inkeep-db` (import plus SpiceDB dump/restore). Retention 7 days. PG 18 confirmed. All open questions resolved.
- rev 2: Drizzle confirmed for the API's database layer (open question 3 closed). Parlant on Postgres added as open question 0.
- rev 1: initial draft.

## Implementation notes

Steps 1–10 and 13 are done, plus the homelab file changes for step 11. Steps 11 (Inkeep rehearsal and cutover) and 12 (old Inkeep databases removed) touch live systems and wait for the user's go-ahead.

Deviations from the plan, with reasons:
- **Steps 3 and 4 were done together.** The store interface went in with all its methods (`touch`, `setParlantSession`, `clearParlantSession`) at once, and the Postgres store with it, rather than a memory-only refactor first.
- **All `IntakeController` handlers are `async`,** so validation errors also surface as rejections (the specs use `rejects.toThrow`).
- **`ParlantService.sessionFor(conversationId, record)`** takes the record the controller already authorized, and `forget` is async.
- **`drizzle.config.ts` lists each schema file,** not `schema/index.ts`: drizzle-kit can't follow its `.js` re-exports.
- **Dependency pins:**
  - `@types/pg` is pinned to `~8.15.6` in the API and LangGraph, to dedupe with the copy Inkeep's packages hoist. A second copy made Drizzle's `NodePgClient` types reject our `Pool`.
  - `@electric-sql/pglite` is pinned to `~0.3.16`, the version Drizzle and `@inkeep/agents-core` resolve, and `@electric-sql/pglite-socket` to `0.0.22`, the last release on pglite 0.3.
- **pglite-socket takes one connection at a time,** so `createCheckpointer` accepts a `poolMax` option, which the spec sets to 1.
- **Parlant's contract oracle is SQLite only.** The transient adapter keeps duplicate ids on insert and skips document loaders, so it isn't a faithful reference. A9 was checked by logging the filters during `test_postgres_stores.py`: events are read by `session_id` (sometimes with `deleted`) and sessions, customers and metadata by `id`, all pushed down. One filter (`customer_tag_associations` by `customer_id`) isn't on the allowlist and is filtered in Python.
- **Step 9 was folded into steps 6 and 8.** `values-dev.yaml` turned the backend PVCs off at the same time as their Postgres, and the old PVCs were deleted once both backends were verified on the cluster.
- **Tilt applies the role Secrets with `kubectl`,** not `k8s_yaml`. Tilt scrubs the values of Secrets it deploys from every log line, and the usernames `langgraph` and `parlant` were being redacted everywhere. The Secrets now outlive `tilt down`, like the cluster.
- **CNPG ordering:** the `parlant` `Database` first failed with "role does not exist" (created before its `DatabaseRole`), and the operator retried it successfully within about 10 s. No change needed.
- **`.env`** got generated `LANGGRAPH_DB_PASSWORD` and `PARLANT_DB_PASSWORD` values (appended; nothing else touched).
- **New homelab network policy (step 10).** A homelab commit made after this plan was approved (`65d4ec7`, a namespace-wide `CiliumNetworkPolicy` in `travel-agent`) would block CNPG in prod: the operator reaching the instance (8000/5432), Prometheus scraping (9187), and the instance manager reaching the Kubernetes API. `apps/travel-agent/postgres-network-policy.yaml` (new, in the kustomization) allows exactly those, for `cnpg.io/cluster: travel-agent-db` pods only. Dev has no such policy.
- **The volume alert** joins `kubelet_volume_stats` to `cnpg_collector_up` by PVC name (CNPG names each PVC after its pod). kube-state-metrics doesn't export PVC labels here, so the planned label-based join returned nothing.

Step 10, prod (2026-11-22; the user applied the policy and alerts and ran `npm run deploy`, then the checks were run):
- `travel-agent-db` is healthy in `travel-agent`; the API retried for about 45 s while it bootstrapped, then logged "Connected; migrations applied";
- an intake claimed on https://travel.honnei.house still authorized after `rollout restart` (wrong key: 403), and the API connects with TLSv1.3; the test row was deleted;
- Prometheus scrapes `travel-agent-db-1` through `travel-agent-db-policy`, and both CNPG alert rules are loaded (inactive).

Step 11 rehearsal (2026-11-22, on a throwaway `inkeep-db-test`, with the live Inkeep untouched):
- The old run DB uses only `plpgsql`, and `appuser` is its only role (a superuser). The import brought over 52 tables in `drizzle` and `public`, all owned by the non-superuser `inkeep` role, with matching row counts on the largest tables.
- `agents-migrate` 0.80.4 ran cleanly against the imported DB as `inkeep` (manage and run migrations, auth init), with no permission errors. Like every rollout, it also re-applied the SpiceDB schema and the admin relationship on the live SpiceDB; both are idempotent.
- The SpiceDB restore (PG 16 → 18) gave 7 tables owned by `spicedb` and matching counts, and `migrate head` and `serve` (1.49.2) ran over TLS as `spicedb`. **But SpiceDB saw 0 of the 4 `project` relationships**: the restored `created_xid` values (about 204k) were ahead of the new server's transaction counter (about 1k). `spicedb datastore repair transaction-ids` advanced the counter past them (to 339,988, in under 2 s), and a fresh SpiceDB then read all 5 relationships. The runbook now has this as step 5b, plus a relationship-count check in the smoke test.
- The `spicedb` `Database` raced its role again, and applied on the operator's retry after about 30 s.
- All rehearsal resources (pods, the cluster, its Secret and PVC) were deleted afterwards.

Verified on the dev cluster (2026-11-22):
- the cluster is healthy; the API logged "Connected; migrations applied" after retrying while the cluster bootstrapped;
- the API and LangGraph connect with TLSv1.3 (`pg_stat_ssl`);
- the `langgraph` role is rejected from the `api` database, and a plain-text connection as `api` is rejected (`pg_hba`);
- LangGraph: after restarting the API and LangGraph pods, the same conversation continued with its earlier messages, and checkpoints are in the `langgraph` database;
- Parlant: after restarting the API and Parlant pods, the same session continued (offset 6, earlier turn in its events), and the stores' collections are in the `parlant` database; `parlant_session_id` is set on the intake record;
- the API's runtime image ships `apps/api/drizzle` and resolves it.

## Review log
### Revision 4

#### Architecture review (rev 4): APPROVE WITH CHANGES

- **A1 [high] Rerunning `generate-inkeep-secret.sh` would regenerate every Inkeep secret, not only the SpiceDB pieces.** Where: step 11 Files and runbook 11.5; `../../homelab/scripts/generate-inkeep-secret.sh:8-18,29-33`.
  - Issue: the script refuses to run when the file exists unless `FORCE=1`. With `FORCE=1` it creates new `DOLTGRES_PASSWORD`, `POSTGRES_PASSWORD`, `SPICEDB_POSTGRES_PASSWORD`, the JWT keypair, the bypass secret, the admin password and every other value. Its own header says "only re-run before first install". Following the runbook would break Doltgres logins (Doltgres keeps the password it was initialised with), the travel-agent API's bypass secret (the Tiltfile reads it from `inkeep-secrets`), and the documented rollback.
  - Recommendation: leave the script alone for this cutover. Create `inkeep-db-spicedb` separately (basic-auth, `openssl rand -hex 32`). Patch only `SPICEDB_DATASTORE_CONN_URI` (and the run DB URL, see A2) in the live `inkeep-secrets` with `kubectl patch`, or regenerate the gitignored YAML from the live Secret. Change the script only for fresh installs, in step 12.
- **A2 [medium] The run DB URL is overridden in `api` and `migrate` only, but `ui` also loads `inkeep-secrets`.** Where: Design "Homelab Inkeep"; `inkeep.yaml:29-44`.
  - Issue: if the manage UI or a later controller reads `INKEEP_AGENTS_RUN_DATABASE_URL`, it keeps writing to the old `inkeep-postgres` after the cutover. That splits the data silently until step 12 deletes the old database. Per-container overrides also leave two sources of truth.
  - Recommendation: after `inkeep-db` bootstraps, patch `INKEEP_AGENTS_RUN_DATABASE_URL` in `inkeep-secrets` itself from `inkeep-db-app/uri`, so no per-container override is needed. Add a gate before step 12: `pg_stat_activity` on both old servers shows no client connections during the soak.
- **A3 [medium] The plan's claim about Parlant's `allow_migration` default is wrong.**
  - Issue: `p.Server(migrate: bool = False)` (`sdk.py:3076`) passes `allow_migration=self._migrate` to every store it builds (`sdk.py:4783`), so `local` runs with `False`. With `False`, a version bump raises `MigrationRequired`. The plan's `True` would migrate silently.
  - Recommendation: decide now. The simplest choice is `False`, which matches today and fails loudly after an upgrade. If `True`, record it as a deliberate change.
- **A4 [medium] The Parlant adapter must run each collection's `document_loader`, and SQL pushdown matches stored documents before the loader runs.**
  - Issue: the SQLite adapter runs the loader on every read, before `matches_filters` (`sqlite.py:211-231`). The plan never mentions `schema` or `document_loader`. With pushdown, `document @> {...}` filters the raw stored JSON, while `matches_filters` sees the loaded document. `CustomerDocumentStore._document_loader` already fills in a missing `kind`, and queries filter on that field. A future converter that adds or renames a field would make a pushed-down `$eq` silently miss rows.
  - Recommendation: state that the adapter applies `document_loader` on every read path. Either write the loader's output back, or limit pushdown to fields loaders never change (`id`, `session_id`). Add a contract case with a loader that adds a field.
- **A5 [medium] The API test seams don't match the planned types and code paths.**
  - Issue: `drizzle-orm/pglite` returns a `PgliteDatabase`, not a `NodePgDatabase`. `migrate.spec.ts` on PGlite would never exercise `runMigrations(pool)` (lock, retry, unlock). PGlite runs one statement at a time, so the claim-race test proves nothing.
  - Recommendation: type `Database` as `PgDatabase<PgQueryResultHKT, typeof schema>`; test `runMigrations` through pglite-socket plus `pg.Pool`, or opt-in on `TEST_DATABASE_URL`; make the race test opt-in against real Postgres, or drop the concurrency claim.
- **A6 [medium] Retention counts only intake writes, not chat activity.**
  - Issue: chat turns only call `authorize`, which never touches `updated_at`, and Inkeep never sets `draft`. A guest still planning 8 days after intake loses the record, and the next turn returns 404.
  - Recommendation: add `last_seen_at`, bumped by `authorize` at most hourly, and prune on it; or state "since last intake write" in Goals and accept it.
- **A7 [medium] Tilt won't sync new migrations into the dev API pod.**
  - Issue: the API's `live_update` syncs only `apps/api/src` and `packages/shared/src`, so `apps/api/drizzle/` stays as built into the image. The pod runs new code against an old schema.
  - Recommendation: `sync('apps/api/drizzle', '/repo/apps/api/drizzle')`, or put it in `fall_back_on`. List the Tiltfile change in step 2.
- **A8 [low] The startup retry window is shorter than the bootstrap, and nothing says who calls `runMigrations`.**
  - Issue: 60 seconds of retries is less than a 1–2-minute bootstrap, so the first deploy crash-loops. The startup probe allows 300 s.
  - Recommendation: retry with backoff for about 240 s, and state that the `DATABASE` async factory awaits `runMigrations` before Nest listens.
- **A9 [low] Normalise `bytea` to a Buffer.** PGlite returns a `Uint8Array`, `pg` a `Buffer`; use `fromDriver: (v) => Buffer.from(v)`.
- **A10 [low] Turbo strips the opt-in test variables.** The `test` task has no `passThroughEnv`. Document running the tests directly, or add the variables.
- **A11 [low] Tidy the SpiceDB restore.** Running `pg_restore` as non-superuser `spicedb` can print ACL errors and exit non-zero; add `--no-acl`. Passing passwords with `--env` puts them in the Pod spec; use `--overrides` with `secretKeyRef`, or `kubectl exec` and pipe over stdin.
- **A12 [low] Name the per-backend objects in the plan.** Tilt selectors depend on the names of the `Database`, `DatabaseRole` and Secret. Also, from step 10, dev inherits `postgres.podMonitor.enabled: true` from the homelab prod values; say whether `values-dev.yaml` overrides it.
- Notes (verified): the CNPG CRDs and `DatabaseRole` fields; every IntakeService call site; `createCheckpointer` and the config enum; the deployment helper (no `valueFrom`, env rendered sorted); the PVC names; `p.Server` accepting store instances; the store constructor signatures; `variable_store` defaulting to `transient`; the drizzle path resolving correctly in the image and under Vitest. Not verified: the PG 18 image, CNPG `pg_hba` ordering and cert SANs, PGlite/pglite-socket behaviour, whether the manage UI reads the run DB URL. Overall the design fits the repo and is sized about right; A1 is the only finding that would cause an outage as written.

#### Security review (rev 4): APPROVE WITH CHANGES

- **S1 [medium] Retention pruning lets a reclaimed conversation id inherit the previous guest's Parlant session.** Where: Retention; `parlant.service.ts:21-44`, `parlant.controller.ts:106-107`, `parlant.client.ts:56-72`, `intake.service.ts:17-22`.
  - Issue: conversation ids come from the browser and become claimable again once the intake record is gone. `threadId` protects LangGraph from this; Parlant has no such protection. `ParlantService` keeps an in-memory `Map<conversationId, sessionId>`, and the Parlant customer id is the conversation id. Today a record mostly disappears on an API restart, which clears that map too. Under this plan, `prune` deletes rows while the API runs and the map is untouched. Whoever next claims a pruned id gets the old session and can stream its events (the previous guest's conversation and PII, now durable). Exploitation needs the 64-bit random id to leak. Inkeep has the same pattern (`chat.service.ts:57-60`), but that exists today and the plan doesn't make it worse.
  - Recommendation: tie the Parlant session to the claim. Store the session id in `intake.conversations` (a nullable `parlant_session_id`), so it's pruned with the record and survives restarts, or key the Parlant customer and session by `threadId`. At minimum, call `ParlantService.forget()` for each pruned id. Add a spec: claim, prune, reclaim, then assert a different session.
- **S2 [low] `GET /api/health/db` is public and must not echo database errors.**
  - Issue: a terminus indicator usually puts the error in the 503 body, so pg errors (`no pg_hba.conf entry…`, `password authentication failed…`) would reach the internet. Unauthenticated callers can also keep the 5-connection pool busy.
  - Recommendation: return a fixed `{status}` with no error text, log details server-side, add a statement timeout or cache, and consider leaving it off the ingress.
- **S3 [low] Parlant's TLS falls back to unverified encryption when the CA is missing.**
  - Issue: with `ssl=None`, asyncpg uses `sslmode=prefer`, which encrypts without checking the certificate, and `hostssl` accepts it. The Node services fail closed instead.
  - Recommendation: default to `verify-full`, or refuse to start unless the host is localhost. Add a unit test for the SSL-option builder in each service.
- **S4 [low] The SpiceDB restore runbook puts both passwords into a pod spec.** `--env` literals are stored in the Pod object, etcd and audit logs, and usually shell history. Recommendation: `kubectl exec … pg_dump | kubectl exec -i inkeep-db-1 -- pg_restore … -U postgres` over local sockets, or `--overrides` with `secretKeyRef`.
- **S5 [low] `inkeep-db` gets none of the `pg_hba` isolation, and its import credential stays referenced.** Both roles can reach either database over plaintext, and `externalClusters` keeps pointing at `inkeep-secrets/POSTGRES_PASSWORD` after step 12 removes the key. Recommendation: add `pg_hba` isolation to `inkeep-db`; in step 12, remove `externalClusters` and re-apply before deleting the old key.
- **S6 [low] Durable conversation PII with no retention, which pruning orphans.** LangGraph checkpoints and Parlant sessions sit in `retain` databases. Pruning intake deletes the only `conversationId → threadId` link, so they can no longer be found and deleted per guest. Recommendation: a `values.yaml` comment (or a `fail`) that the backends' Postgres must not be enabled in prod until the retention follow-up exists, and the follow-up must work on checkpoint and session age.
- Notes: verified the intake call sites, the deployment helper, `dev_secret` (it emits `Opaque` and skips empty keys, so `basic_auth_secret` must set `kubernetes.io/basic-auth` itself), the URL-safe `rand()`, `ConversationIdSchema`, and LangGraph's `checkpointer.ts`/`config.ts`. A4/A5 not verifiable from the repo. node-postgres lets `sslmode` in a URL override the `ssl` option, so the S3 tests should cover that. Related to S1: Parlant conversations don't survive an API restart today; storing the session id fixes both.

#### Risk review (rev 4): APPROVE WITH CHANGES

- **R1 [high] Inkeep cutover has no off-cluster copy, and the rollback path is more fragile than stated.**
  - Issue: the only safety net is the old StatefulSets; no `pg_dump` is required and `inkeep-db` has no backups. `generate-inkeep-secret.sh` needs `FORCE=1` and then regenerates every password, which breaks the import source and the rollback target. "Revert the secret" needs the old SpiceDB URI saved. Step 12 deletes the last copy with no final dump.
  - Mitigation: off-cluster `pg_dump -Fc` of both databases plus Longhorn snapshots before step 11; emit only the new Secret and URI, or `kubectl patch`; save the old URI; a final dump before step 12.
- **R2 [high] The import assumes the old database never needed superuser, but only ownership was checked.**
  - Issue: `appuser` is a superuser today; afterwards the run DB connects as non-superuser `inkeep`. If `agents-migrate` or a runtime path does `CREATE EXTENSION` (for example pgvector), `SET ROLE` or touches `pg_catalog`, it fails after the data is imported and services are down. The same applies to SpiceDB 1.49.2 moving from PG 16 to 18.
  - Mitigation: a rehearsal on a throwaway `inkeep-db-test` (import, scratch `agents-migrate`, `spicedb migrate head` plus a read on a scratch restore) before the real window; record `\dx`/`\du`; add the check to A3.
- **R3 [medium] The API's DB connect retry (60 s) is shorter than first bootstrap, and `helm --wait` is 5 minutes.**
  - Issue: a slow bootstrap crash-loops the API with backoff, eats into `--wait`, and can leave the prod release `failed`. Tilt shows noisy restarts.
  - Mitigation: about 4 minutes of retry with backoff, or a `pg_isready` init container; optionally enable `postgres.enabled` in prod before flipping the API.
- **R4 [medium] Intake retention keys on `updated_at`, which only writes bump.** A conversation that keeps chatting without writes for 7 days is pruned, and its next turn 404s. Mitigation: touch on `authorize` (throttled), or define retention as since last activity, with a test.
- **R5 [medium] Intake is now unbounded and unauthenticated, in a database shared by all services.** The memory store's 10,000 cap goes away. A flood of `PUT /intake/<random>/identity` can fill the 5Gi volume before prune runs, taking down checkpoints and sessions too. Mitigation: a row cap in `claim`, or a per-IP throttle, plus a disk alert.
- **R6 [medium] Parlant `allow_migration=True` doesn't match the default it claims to match.** `p.Server(migrate=False)` is the default, so `local` runs with `False`. Mitigation: use `False`, or the same flag as the `Server`.
- **R7 [medium] Dev/prod test coverage differs from production behaviour in places.** PGlite `bytea` is a `Uint8Array` (the security-relevant `timingSafeEqual` path); `NodePgDatabase` types don't fit PGlite; the advisory lock can't run on PGlite; no test for `DATABASE_URL` set but unreachable. Mitigation: normalize with `Buffer.from`; one real-PG integration run; an explicit unreachable-DB test.
- **R8 [medium] Nothing alerts on database failure.** The liveness probe is DB-free, so a dead database shows only as 500s, and the PodMonitor has no alert rule. Mitigation: alerts on `cnpg_collector_up == 0` and PVC usage above 80%.
- **R9 [medium] Parlant adapter correctness details are left to the implementer.** asyncpg returns `jsonb` as `str` without a codec; `@>` differs from `matches_filters` on arrays, nulls and missing fields, and a wrong exclusion is silent; the `||` merge is shallow; the in-process lock only works because replicas are 1. Mitigation: contract cases for null/list/missing; name the `set_type_codec` requirement; restrict pushdown to scalar `$eq`.
- **R10 [low] `pg_hba` reject rule depends on A5, which is verified only after it's in use.** Keep dev before prod and make the reject line an explicit values toggle.
- **R11 [low] Shared single instance, 512Mi limit, no replica.** A drain takes intake, LangGraph and Parlant down together; prod gains a new dependency. Accept it, and note it in step 10.
- **R12 [low] Smaller items.** The `--env` passwords in `kubectl run`; confirm replica counts come back after scale-to-0 and `helm upgrade`; make sure steps 6 and 8 are confirmed on the dev cluster before step 9 deletes PVCs.
- Notes: A5, A1, A2, the `DatabaseRole` fields, pglite-socket, `tilt.dev/down-policy`, SpiceDB on PG 18 and the old run DB's extensions were not verified (no cluster access).

#### Dispositions

| ID | Severity | Disposition | Note |
|---|---|---|---|
| A1 | high | [accepted] | Step 11 never re-runs the script; it patches two keys and saves the old values. The script changes in step 12. |
| A2 | medium | [accepted] | The run DB URL is patched in `inkeep-secrets` itself (no per-container override), plus a `pg_stat_activity` gate before step 12. |
| A3 | medium | [accepted] | `allow_migration=False` / `migrate=False`, matching `p.Server`'s default. |
| A4 | medium | [accepted] | The loader runs on every read; pushdown only on an allowlist (`id`, `session_id`); a contract case with a loader that adds a field. |
| A5 | medium | [accepted] | `PgDatabase` base type; `runMigrations` and the race tests opt-in on real Postgres. |
| A6 | medium | [accepted] | `last_seen_at`, bumped by `authorize` at most hourly; prune on it. |
| A7 | medium | [accepted] | Tilt syncs `apps/api/drizzle`; listed in step 2. |
| A8 | low | [accepted] | Backoff retry for up to 4 minutes; the factory awaits `runMigrations` before Nest listens. |
| A9 | low | [accepted] | `fromDriver: Buffer.from`, with a test. |
| A10 | low | [accepted] | The `test` task passes `TEST_DATABASE_URL` and `PARLANT_TEST_DATABASE_URL` through. |
| A11 | low | [accepted] | Socket-based `kubectl exec` pipe with `--no-acl`. |
| A12 | low | [accepted] | Object names written down; dev keeps the PodMonitor. |
| S1 | medium | [accepted] | `parlant_session_id` on the intake record; the `Map` only dedupes and is keyed by `threadId`; a spec for prune then reclaim. Also makes Parlant survive API restarts. |
| S2 | low | [accepted] | The route is dropped instead of hardened: nothing uses it, and CNPG metrics plus alerts cover database health. |
| S3 | low | [accepted] | Fail-closed TLS in all three services, with unit tests; an `sslmode` in the URL is rejected. |
| S4 | low | [accepted] | Same fix as A11. |
| S5 | low | [accepted] | `pg_hba` isolation on `inkeep-db`; step 12 removes `externalClusters` and the import block. |
| S6 | low | [accepted] | A `values.yaml` comment, and the retention follow-up (by age, required before prod) is spelled out in Follow-ups. |
| R1 | high | [accepted] | Saved Secret values, and a Longhorn backup of the old volumes before the cutover (deleted after step 12). Rev 6: the off-cluster dumps and final dump were dropped at the user's request, since these aren't prod systems yet. |
| R2 | high | [accepted] | A rehearsal on `inkeep-db-test` before the cutover; A3 now covers superuser, extensions and SpiceDB on PG 18. |
| R3 | medium | [accepted] | Same fix as A8. A separate prod enable isn't needed, because the API waits rather than crash-looping. |
| R4 | medium | [accepted] | Same fix as A6. |
| R5 | medium | [accepted] | `INTAKE_MAX_CONVERSATIONS` (10,000) row cap, enforced on claim at most once a minute and on prune; a disk alert (R8). A per-IP throttle is not added. |
| R6 | medium | [accepted] | Same fix as A3. |
| R7 | medium | [accepted] | Same fixes as A5 and A9, plus an unreachable-DB test. |
| R8 | medium | [accepted] | A `PrometheusRule` in the homelab repo (step 10). |
| R9 | medium | [accepted] | The `jsonb` codec is named in the design; scalar-only, allowlisted pushdown; null/list/missing contract cases; the shallow merge and the single-replica lock are stated. |
| R10 | low | [accepted] | `postgres.isolation.rejectOthers` toggle. |
| R11 | low | [accepted] | Noted in step 10 as an accepted trade-off. |
| R12 | low | [accepted] | Replica-count check in the runbook; the socket restore (A11); step 9 already gates on steps 6 and 8 being verified on the dev cluster. |
