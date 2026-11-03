#!/usr/bin/env bash
# Create .env from .env.example, filling every <generated> value with a fresh secret.
# Refuses to overwrite an existing .env.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -e .env ]]; then
  echo ".env already exists; delete it first to regenerate." >&2
  exit 1
fi

rand() { openssl rand -base64 32 | tr -d '\n/+=' ; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
openssl genrsa -out "$tmp/priv.pem" 2048 2>/dev/null
openssl rsa -in "$tmp/priv.pem" -pubout -out "$tmp/pub.pem" 2>/dev/null
jwt_priv=$(base64 -w0 "$tmp/priv.pem")
jwt_pub=$(base64 -w0 "$tmp/pub.pem")

while IFS= read -r line; do
  key=${line%%=*}
  if [[ $line == *'=<generated>' ]]; then
    case $key in
      INKEEP_AGENTS_TEMP_JWT_PRIVATE_KEY) value=$jwt_priv ;;
      INKEEP_AGENTS_TEMP_JWT_PUBLIC_KEY) value=$jwt_pub ;;
      # Inkeep's password policy wants mixed case, a digit and a symbol.
      INKEEP_AGENTS_MANAGE_UI_PASSWORD) value="$(rand | cut -c1-20)Aa1!" ;;
      *) value=$(rand) ;;
    esac
    printf '%s=%s\n' "$key" "$value"
  else
    printf '%s\n' "$line"
  fi
done < .env.example > .env
chmod 600 .env

echo "Wrote .env. Set ANTHROPIC_API_KEY in it, then: docker compose up -d inkeep-agents-manage-ui"
