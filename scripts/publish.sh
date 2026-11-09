#!/usr/bin/env bash
# Build and push the runtime images and the Helm chart to Gitea.
#
# The chart is published as <Chart.yaml version>-g<sha> with appVersion=<sha>;
# image tags default to appVersion, so each chart version pins its images.
# Prints the chart version on the last line of stdout.
#
# Needs: docker login code.honnei.house && helm registry login code.honnei.house
# Usage: scripts/publish.sh
set -euo pipefail
cd "$(dirname "$0")/.."

REGISTRY="${REGISTRY:-code.honnei.house/admin}"
CHART=deploy/helm/travel-agent

# Unique per build so pods always roll to the new images.
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  TAG="${TAG}-dirty-$(date +%s)"
fi
BASE_VERSION="$(awk '/^version:/ {print $2}' "${CHART}/Chart.yaml" | tr -d "'\"")"
# "g" prefix keeps the SemVer pre-release valid even for all-digit SHAs.
CHART_VERSION="${BASE_VERSION}-g${TAG}"

REGISTRY="${REGISTRY}" ./scripts/docker-build.sh "${TAG}" --push >&2

pkg_dir="$(mktemp -d)"
trap 'rm -rf "${pkg_dir}"' EXIT
helm package "${CHART}" --version "${CHART_VERSION}" --app-version "${TAG}" \
  --destination "${pkg_dir}" >&2
helm push "${pkg_dir}/travel-agent-${CHART_VERSION}.tgz" "oci://${REGISTRY}" >&2

echo "${CHART_VERSION}"
