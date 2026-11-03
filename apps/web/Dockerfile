# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/web/Dockerfile .
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-alpine AS base
ENV TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo

# Reduce the monorepo to just the web app and the workspaces it depends on.
FROM base AS prune
RUN npm install -g turbo@2.11.10
COPY . .
RUN turbo prune @travel-agent/web --docker

# Install dependencies from manifests only, so this layer is cached until they change.
FROM base AS deps
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS source
COPY --from=prune /repo/out/full/ .
COPY tsconfig.base.json ./

# Dev image for Tilt: Vite serves with HMR as source is live-synced in.
FROM source AS dev
ENV TURBO_UI=false \
    VITE_HOST=0.0.0.0
RUN npx turbo run build --filter=@travel-agent/shared
EXPOSE 5173
CMD ["npx", "turbo", "run", "dev", "--filter=@travel-agent/web..."]

FROM source AS build
RUN npx turbo run build --filter=@travel-agent/web

FROM nginxinc/nginx-unprivileged:1-alpine AS runtime
# API_UPSTREAM is substituted into the template by the nginx entrypoint at startup.
ENV API_UPSTREAM=http://api:3000
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
