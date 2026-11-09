# Travel Agent

TypeScript monorepo: a Chakra UI v3 frontend and a NestJS (Fastify) API, on Node 26,
deployed to the homelab k3s cluster with Helm.

```
apps/api          NestJS 12 + @nestjs/platform-fastify   → /api/*
apps/web          Vite 8 + React 19 + Chakra UI v3       → /
packages/shared   zod schemas + types used by both apps
deploy/helm       Helm chart (generic defaults + values-dev.yaml for Tilt)
Tiltfile          in-cluster dev loop with live sync
```

npm workspaces link the packages; Turborepo orchestrates tasks and prunes the repo
for Docker builds.

## Setup

```sh
mise install    # node 26 + tilt (see mise.toml)
npm install
```

## Local development

```sh
npm run dev     # shared (tsc --watch), api on :3000, web on :5173
```

Vite proxies `/api` to the API, so the browser only ever talks to one origin.

Other tasks run across every workspace through Turbo: `npm run build`, `lint`,
`typecheck`, `test`. Use `npm run test:e2e -w @travel-agent/api` for API e2e tests.

## Chat agent (Inkeep)

The chat panel is backed by a self-hosted [Inkeep](https://github.com/inkeep/agents)
agent. The browser posts to `/api/chat`; the Nest API forwards it to Inkeep's run API
with a server-side secret and streams the reply back (Vercel AI SDK `useChat` format).

```
apps/agents       Inkeep project/agent definitions (@inkeep/agents-sdk), pushed with the CLI
apps/api/src/chat /api/chat proxy → Inkeep /run/api/chat
docker-compose    inkeep-* services: agents API (:3002), visual builder (:3001), Postgres,
                  Doltgres, SpiceDB
```

First-time setup:

```sh
./scripts/init-env.sh                         # writes .env with generated secrets
$EDITOR .env                                  # set ANTHROPIC_API_KEY
docker compose up -d inkeep-agents-manage-ui  # Inkeep stack + its dependencies
npm run push -w @travel-agent/agents          # load the agent into Inkeep
npm run dev
```

Re-run the push after editing anything under `apps/agents/src`. The visual builder at
http://localhost:3001 (credentials in `.env`) shows the agent and conversation traces.
The `@inkeep/*` packages are pinned to the image version (`INKEEP_VERSION`, 0.80.4), and
a root `overrides` entry keeps them on zod 4.5, since zod 4.6 breaks Inkeep 0.80.

## Containers

Each app has a multi-stage Dockerfile, built from the repo root:

- `dev` — runs the watchers; used by Tilt
- `runtime` — production image (`node:26-alpine` for the API, `nginx-unprivileged` for web)

```sh
docker compose up --build     # production images on :3000 / :8080
                              # (WEB_PORT=8081 if 8080 is taken)
```

## Homelab cluster

The chart here is generic. Everything specific to the homelab cluster (hostname, TLS,
image repositories, node placement, Inkeep URL) lives in the homelab repo:
`helm-values/travel-agent.yaml`, plus `travel-agent-dev.yaml` for the dev loop. Both
`tilt up` and `npm run deploy` expect the homelab repo at `../../homelab`. Set
`HOMELAB_DIR` if it's somewhere else.

| | Namespace | URL |
| :--- | :--- | :--- |
| Release (`npm run deploy`) | `travel-agent` | https://travel.honnei.house |
| Dev loop (`tilt up`) | `travel-agent-dev` | https://travel-dev.honnei.house |

Cilium ingress routes `/api` to the API and everything else to web. TLS uses the homelab's
Let's Encrypt wildcard cert, and external-dns publishes the records. Images go to
`code.honnei.house/admin/travel-agent-{api,web}` and are built amd64-only. The homelab
values pin pods to amd64 nodes, since amalthea and adrastea are arm64.

One-time registry login (Gitea credentials):

```sh
docker login code.honnei.house
helm registry login code.honnei.house
```

**Dev loop:**

```sh
tilt up
```

This builds the `dev` images, pushes them, and helm-deploys into `travel-agent-dev` with
the homelab values plus `values-dev.yaml`. Edits under `src/` sync into the running pods
and hot-reload. Changes to `package.json` or the lockfile trigger a full image rebuild.
`tilt down` only removes the dev deployment.

**Release-style deploy:**

```sh
npm run deploy
```

This runs `scripts/publish.sh`, which builds the `runtime` images and tags them with the
git SHA, then publishes the chart to `oci://code.honnei.house/admin/travel-agent` as
`<chart version>-g<sha>`. The chart's image tags default to its appVersion (the SHA), so
each chart version pins its images. The script then runs `helm upgrade --install` with
that version and the homelab values. Use `scripts/publish.sh` alone to publish without
deploying.
