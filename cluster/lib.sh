#!/usr/bin/env bash
# Shared constants + helpers for the in-cluster e2e scripts.
set -euo pipefail

CLUSTER_NAME="zed-e2e"
NAMESPACE="zed"
API_URL="http://127.0.0.1:48080"
WEB_URL="http://127.0.0.1:48081"
API_IMAGE="ghcr.io/zed-pkg/zed-api-server:dev"
WEB_IMAGE="ghcr.io/zed-pkg/zed-web-server:dev"

# cluster/ -> zed-e2e/ -> repo root (the sibling checkout / monorepo apps dir).
CLUSTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_ROOT="$(cd "$CLUSTER_DIR/.." && pwd)"
REPO_ROOT="$(cd "$E2E_ROOT/.." && pwd)"
MANIFESTS_DIR="$CLUSTER_DIR/manifests"

KCTL=(kubectl --context "kind-${CLUSTER_NAME}")

log() { printf '\033[1;36m[cluster]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[cluster] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found on PATH"; }
