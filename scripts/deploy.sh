#!/usr/bin/env bash
# Publish (scripts/publish.sh), then deploy that chart version to the homelab
# cluster. Cluster-specific values live in the homelab repo
# (helm-values/travel-agent.yaml); set HOMELAB_DIR if it isn't at ../../homelab.
set -euo pipefail
cd "$(dirname "$0")/.."

REGISTRY="${REGISTRY:-code.honnei.house/admin}"
NAMESPACE="${NAMESPACE:-travel-agent}"
HOMELAB_DIR="${HOMELAB_DIR:-$(cd ../.. && pwd)/homelab}"
VALUES="${HOMELAB_DIR}/helm-values/travel-agent.yaml"

if [[ ! -f "${VALUES}" ]]; then
  echo "Missing ${VALUES}. Clone the homelab repo or set HOMELAB_DIR." >&2
  exit 1
fi

CHART_VERSION="$(REGISTRY="${REGISTRY}" ./scripts/publish.sh | tail -n1)"

helm upgrade --install travel-agent "oci://${REGISTRY}/travel-agent" \
  --version "${CHART_VERSION}" \
  --namespace "${NAMESPACE}" --create-namespace \
  -f "${VALUES}" \
  --wait --timeout 5m

echo "Deployed travel-agent chart ${CHART_VERSION} to ${NAMESPACE}"
