#!/usr/bin/env bash
# Build the production images. They're amd64-only; the homelab chart pins pods
# to amd64 nodes (homelab repo: helm-values/travel-agent.yaml).
# Usage: scripts/docker-build.sh [tag] [--push]
set -euo pipefail
cd "$(dirname "$0")/.."

REGISTRY="${REGISTRY:-code.honnei.house/admin}"
TAG="${1:-latest}"
PUSH="${2:-}"

for app in api web; do
  image="${REGISTRY}/travel-agent-${app}:${TAG}"
  echo "==> Building ${image}"
  docker build --platform linux/amd64 --target runtime \
    -f "apps/${app}/Dockerfile" -t "${image}" .
  if [[ "${PUSH}" == "--push" ]]; then
    docker push "${image}"
  fi
done
