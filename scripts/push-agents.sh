#!/usr/bin/env bash
# Push the Inkeep agents to the homelab Inkeep for one environment. Each
# environment has its own Inkeep project, pointed at its own namespace's API,
# so pushing one never repoints the other:
#
#   dev   project travel-agent-dev → http://travel-agent-api.travel-agent-dev:3000
#   prod  project travel-agent     → http://travel-agent-api.travel-agent:3000
#
# The manage API key is read from the cluster (inkeep/inkeep-secrets), never
# from .env, whose Inkeep settings are for the local Docker stack (`npm run
# push` in apps/agents).
#
# The CLI runs with a throwaway HOME holding only a "homelab" profile: the
# user's own active profile would otherwise override inkeep.config.ts, and the
# key is only accepted as a Bearer token, which INKEEP_CI mode doesn't send.
#
# Usage: scripts/push-agents.sh dev|prod
# Env:   INKEEP_API (default https://inkeep-api.honnei.house)
#        INKEEP_UI  (default https://inkeep.honnei.house)
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  dev) NAMESPACE=travel-agent-dev PROJECT=travel-agent-dev ;;
  prod) NAMESPACE=travel-agent PROJECT=travel-agent ;;
  *)
    echo "Usage: $0 dev|prod" >&2
    exit 1
    ;;
esac

INKEEP_API="${INKEEP_API:-https://inkeep-api.honnei.house}"
INKEEP_UI="${INKEEP_UI:-https://inkeep.honnei.house}"

KEY="$(kubectl -n inkeep get secret inkeep-secrets \
  -o jsonpath='{.data.INKEEP_AGENTS_MANAGE_API_BYPASS_SECRET}' | base64 -d)"
if [[ -z "${KEY}" ]]; then
  echo "inkeep/inkeep-secrets has no INKEEP_AGENTS_MANAGE_API_BYPASS_SECRET." >&2
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
