#!/usr/bin/env bash
# Build, push, and helm-deploy the production images to the homelab cluster.
set -euo pipefail
cd "$(dirname "$0")/.."

NAMESPACE="${NAMESPACE:-travel-agent}"
CHART=deploy/helm/travel-agent

# Unique tag per deploy so pods always roll to the new image.
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  TAG="${TAG}-dirty-$(date +%s)"
fi

./scripts/docker-build.sh "${TAG}" --push

helm upgrade --install travel-agent "${CHART}" \
  --namespace "${NAMESPACE}" --create-namespace \
  -f "${CHART}/values-homelab.yaml" \
  --set api.image.tag="${TAG}" \
  --set web.image.tag="${TAG}" \
  --wait --timeout 5m
