#!/usr/bin/env bash
# Tests the project Alloy's token rule (templates/alloy.yaml) against recorded span
# shapes, with the same Alloy version the chart pins. Needs docker, helm, python3.
#   deploy/alloy/test/token-rule.sh
set -euo pipefail
cd "$(dirname "$0")"
chart=../../helm/travel-agent
image="grafana/alloy:$(helm show values "$chart" | awk '/^  collector:/{c=1} c&&/tag:/{print $2; exit}')"
tmp=$(mktemp -d)
net="alloy-token-test-$$"
cleanup() { docker rm -f "$net-recv" "$net-sut" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
[[ -n "${KEEP:-}" ]] || trap cleanup EXIT

# The chart's collector config, forwarding to the stand-in receiver.
helm template "$chart" --set otel.enabled=true,otel.upstreamEndpoint="http://$net-recv:4318" \
  --show-only templates/alloy.yaml |
  awk '/^  config.alloy: \|/{f=1;next} f&&/^---/{exit} f' | sed 's/^    //' >"$tmp/config.alloy"
cp receiver.alloy "$tmp/receiver.alloy"

docker network create "$net" >/dev/null
docker run -d --name "$net-recv" --network "$net" -v "$tmp:/etc/alloy:ro" "$image" \
  run --stability.level=experimental --storage.path=/tmp/a /etc/alloy/receiver.alloy >/dev/null
docker run -d --name "$net-sut" --network "$net" -p 127.0.0.1::4318 -v "$tmp:/etc/alloy:ro" "$image" \
  run --stability.level=experimental --storage.path=/tmp/a /etc/alloy/config.alloy >/dev/null
port=$(docker port "$net-sut" 4318/tcp | head -1 | cut -d: -f2)
for _ in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$port/v1/traces" -X POST -H 'content-type: application/json' -d '{}' && break; sleep 1; done

python3 -I fixtures.py | curl -sf -o /dev/null -X POST "http://127.0.0.1:$port/v1/traces" \
  -H 'content-type: application/json' --data-binary @-
# The interval processor sends every 15 s; give it two rounds.
sleep 35
docker logs "$net-recv" 2>&1 | python3 -I check.py
