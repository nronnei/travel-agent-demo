# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/api/Dockerfile .
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-alpine AS base
ENV TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo

# Reduce the monorepo to just the api and the workspaces it depends on.
FROM base AS prune
RUN npm install -g turbo@2.11.10
COPY . .
RUN turbo prune @travel-agent/api --docker

# Install dependencies from manifests only, so this layer is cached until they change.
FROM base AS deps
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS source
COPY --from=prune /repo/out/full/ .
COPY tsconfig.base.json ./

# Dev image for Tilt: watchers rebuild shared + api as source is live-synced in.
FROM source AS dev
ENV TURBO_UI=false
RUN npx turbo run build --filter=@travel-agent/shared
EXPOSE 3000
CMD ["npx", "turbo", "run", "dev", "--filter=@travel-agent/api..."]

FROM source AS build
RUN npx turbo run build --filter=@travel-agent/api

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
USER node
WORKDIR /repo/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
