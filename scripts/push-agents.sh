#!/usr/bin/env bash
# Push the Inkeep agents for one environment. Each environment has its own
# Inkeep project, pointed at its own namespace's API:
#
#   dev   project travel-agent-dev → http://travel-agent-api.travel-agent-dev:3000
#         Inkeep: the chart's own (inkeep.server.enabled), through Tilt's
#         port-forward on localhost:3002. Tilt's inkeep-push resource runs this.
#   prod  project travel-agent     → http://travel-agent-api.travel-agent:3000
#         Inkeep: the homelab install until the cutover. After it, point at the
#         chart's prod Inkeep: kubectl -n travel-agent port-forward
#         svc/travel-agent-inkeep-api 3002, then
#         INKEEP_API=http://localhost:3002 INKEEP_SECRET=travel-agent/travel-agent-inkeep-server
#
# The manage API key comes from INKEEP_MANAGE_KEY, or from the Inkeep server's
# Secret in the cluster, never from .env.
#
# The CLI runs with a throwaway HOME holding only a "homelab" profile: the
# user's own active profile would otherwise override inkeep.config.ts, and the
# key is only accepted as a Bearer token, which INKEEP_CI mode doesn't send.
#
# Usage: scripts/push-agents.sh dev|prod
# Env:   INKEEP_API, INKEEP_UI   the Inkeep API and manage UI (defaults per environment)
#        INKEEP_SECRET            namespace/name of the Inkeep server's Secret
#        INKEEP_MANAGE_KEY        the manage API bypass secret, instead of reading it
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  dev)
    NAMESPACE=travel-agent-dev PROJECT=travel-agent-dev
    DEFAULT_API=http://localhost:3002 DEFAULT_UI=http://localhost:3003
    DEFAULT_SECRET=travel-agent-dev/travel-agent-inkeep-dev
    ;;
  prod)
    NAMESPACE=travel-agent PROJECT=travel-agent
    DEFAULT_API=https://inkeep-api.honnei.house DEFAULT_UI=https://inkeep.honnei.house
    DEFAULT_SECRET=inkeep/inkeep-secrets
    ;;
  *)
    echo "Usage: $0 dev|prod" >&2
    exit 1
    ;;
esac

INKEEP_API="${INKEEP_API:-${DEFAULT_API}}"
INKEEP_UI="${INKEEP_UI:-${DEFAULT_UI}}"
INKEEP_SECRET="${INKEEP_SECRET:-${DEFAULT_SECRET}}"

KEY="${INKEEP_MANAGE_KEY:-}"
if [[ -z "${KEY}" ]]; then
  KEY="$(kubectl -n "${INKEEP_SECRET%%/*}" get secret "${INKEEP_SECRET#*/}" \
    -o jsonpath='{.data.INKEEP_AGENTS_MANAGE_API_BYPASS_SECRET}' | base64 -d)"
fi
if [[ -z "${KEY}" ]]; then
  echo "${INKEEP_SECRET} has no INKEEP_AGENTS_MANAGE_API_BYPASS_SECRET." >&2
  exit 1
fi

home="$(mktemp -d)"
trap 'rm -rf "${home}"' EXIT
mkdir -p "${home}/.inkeep"
cat >"${home}/.inkeep/profiles.yaml" <<EOF
activeProfile: homelab
profiles:
  homelab:
    remote:
      api: ${INKEEP_API}
      manageUi: ${INKEEP_UI}
    credential: none
    environment: production
EOF

echo "Pushing Inkeep project ${PROJECT} → API in ${NAMESPACE}" >&2
cd apps/agents
HOME="${home}" \
  INKEEP_PROJECT_ID="${PROJECT}" \
  INTAKE_API_URL="http://travel-agent-api.${NAMESPACE}:3000" \
  INKEEP_AGENTS_API_URL="${INKEEP_API}" \
  INKEEP_AGENTS_MANAGE_API_BYPASS_SECRET="${KEY}" \
  npx inkeep push --project src/projects/travel-agent --profile homelab
