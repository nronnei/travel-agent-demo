#!/usr/bin/env bash
# Secrets for the in-chart Inkeep (inkeep.server.enabled).
#
#   scripts/inkeep-secrets.sh generate
#       Prints freshly generated values as KEY=VALUE lines. Tilt runs this once into
#       the gitignored .tilt/inkeep-dev.env and reuses it, so dev sessions and JWTs
#       survive restarts.
#
#   ANTHROPIC_API_KEY=... ADMIN_EMAIL=me@example.com scripts/inkeep-secrets.sh prod
#       Creates the prod Secrets in the travel-agent namespace, straight from memory
#       (nothing is written to disk):
#         travel-agent-inkeep-server   the Inkeep server's Secret (inkeep.server.secret)
#         travel-agent-db-inkeep       basic-auth for the "inkeep" database role
#         travel-agent-db-spicedb      basic-auth for the "spicedb" database role
#       SEARCH_API_TOKEN and INTAKE_API_TOKEN are copied from the API's Secret
#       (travel-agent-inkeep), never generated: Inkeep sends them back to the API.
#       Refuses to run if the server Secret already exists (rotating would sign
#       everyone out and orphan the database roles' passwords).
#
# Env: NAMESPACE (default travel-agent), API_SECRET (default travel-agent-inkeep),
#      SERVER_SECRET (default travel-agent-inkeep-server), DB_SECRET_PREFIX
#      (default travel-agent-db).
set -euo pipefail

hex() { openssl rand -hex 32; }

generate() {
  local tmp
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  openssl genrsa -out "$tmp/priv.pem" 2048 2>/dev/null
  openssl rsa -in "$tmp/priv.pem" -pubout -out "$tmp/pub.pem" 2>/dev/null
  # Inkeep's password policy requires upper, lower, digit and special characters.
  echo "INKEEP_AGENTS_MANAGE_UI_USERNAME=${ADMIN_EMAIL:-admin@example.com}"
  echo "INKEEP_AGENTS_MANAGE_UI_PASSWORD=Ik-$(openssl rand -hex 16)!"
  echo "INKEEP_AGENTS_RUN_API_BYPASS_SECRET=$(hex)"
  echo "INKEEP_AGENTS_MANAGE_API_BYPASS_SECRET=$(hex)"
  echo "BETTER_AUTH_SECRET=$(hex)"
  echo "INKEEP_ANON_JWT_SECRET=$(hex)"
  # Signs the service tokens Inkeep's runtime uses (required in production).
  echo "INKEEP_AGENTS_JWT_SIGNING_SECRET=$(hex)"
  echo "SPICEDB_PRESHARED_KEY=$(hex)"
  echo "DOLTGRES_PASSWORD=$(hex)"
  echo "INKEEP_AGENTS_TEMP_JWT_PRIVATE_KEY=$(base64 -w0 <"$tmp/priv.pem")"
  echo "INKEEP_AGENTS_TEMP_JWT_PUBLIC_KEY=$(base64 -w0 <"$tmp/pub.pem")"
  # The two CNPG roles' passwords (basic-auth Secrets, not the server's Secret).
  echo "INKEEP_DB_PASSWORD=$(hex)"
  echo "SPICEDB_DB_PASSWORD=$(hex)"
}

# A Secret manifest on stdout, from KEY=VALUE lines on stdin (values YAML-quoted).
# Values go through pipes only, never argv, so they don't show up in `ps`.
secret_yaml() {
  local ns="$1" name="$2" type="$3"
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: %s\ntype: %s\nstringData:\n' "$name" "$ns" "$type"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    printf "  %s: '%s'\n" "${line%%=*}" "$(sed "s/'/''/g" <<<"${line#*=}")"
  done
}

prod() {
  local ns="${NAMESPACE:-travel-agent}" api="${API_SECRET:-travel-agent-inkeep}"
  local server="${SERVER_SECRET:-travel-agent-inkeep-server}" db="${DB_SECRET_PREFIX:-travel-agent-db}"
  : "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY}"
  if kubectl -n "$ns" get secret "$server" >/dev/null 2>&1; then
    echo "$ns/$server already exists; not rotating it." >&2
    exit 1
  fi
  local copied="" key value
  for key in SEARCH_API_TOKEN INTAKE_API_TOKEN; do
    value=$(kubectl -n "$ns" get secret "$api" -o "jsonpath={.data.$key}" | base64 -d)
    [[ -n "$value" ]] || { echo "$ns/$api has no $key" >&2; exit 1; }
    copied+="$key=$value"$'\n'
  done
  local gen
  gen=$(generate)
  {
    echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
    printf '%s' "$copied"
    grep -vE '^(INKEEP|SPICEDB)_DB_PASSWORD=' <<<"$gen"
  } | secret_yaml "$ns" "$server" Opaque | kubectl apply -f - >/dev/null
  local role upper
  for role in inkeep spicedb; do
    upper=$(tr a-z A-Z <<<"$role")
    printf 'username=%s\npassword=%s\n' "$role" "$(grep "^${upper}_DB_PASSWORD=" <<<"$gen" | cut -d= -f2-)" |
      secret_yaml "$ns" "$db-$role" kubernetes.io/basic-auth | kubectl apply -f - >/dev/null
  done
  echo "Created $ns/$server, $ns/$db-inkeep and $ns/$db-spicedb." >&2
  echo "Manage UI login: $(grep '^INKEEP_AGENTS_MANAGE_UI_USERNAME=' <<<"$gen" | cut -d= -f2-) (password in $ns/$server)." >&2
}

case "${1:-}" in
  generate) generate ;;
  prod) prod ;;
  *)
    echo "Usage: $0 generate|prod" >&2
    exit 1
    ;;
esac
