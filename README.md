# Travel Agent

TypeScript monorepo: a Chakra UI v3 frontend and a NestJS (Fastify) API, on Node 26,
deployed to the homelab k3s cluster with Helm.

```
apps/api          NestJS 12 + @nestjs/platform-fastify   → /api/*
apps/web          Vite 8 + React 19 + Chakra UI v3       → /
packages/shared   zod schemas + types used by both apps
deploy/helm       Helm chart (values-homelab.yaml, values-dev.yaml)
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

## Containers

Each app has a multi-stage Dockerfile, built from the repo root:

- `dev` — runs the watchers; used by Tilt
- `runtime` — production image (`node:26-alpine` for the API, `nginx-unprivileged` for web)

```sh
docker compose up --build     # production images on :3000 / :8080
                              # (WEB_PORT=8081 if 8080 is taken)
```

## Homelab cluster

The app is served at https://travel.home.lab. Cilium ingress routes `/api` to the API and
everything else to web; cert-manager (`homelab-ca`) issues TLS and external-dns publishes
the record. Images go to `code.home.lab/admin/travel-agent-{api,web}`. They're built
amd64-only, and the chart pins pods to amd64 nodes, since amalthea and adrastea are arm64.

**Dev loop:**

```sh
tilt up
```

This builds the `dev` images, pushes them, and helm-deploys with `values-dev.yaml`. Edits
under `src/` sync into the running pods and hot-reload. Changes to `package.json` or the
lockfile trigger a full image rebuild.

**Release-style deploy:**

```sh
npm run deploy
```

This builds the `runtime` images, tags them with the git SHA, pushes them, and runs
`helm upgrade --install`.
