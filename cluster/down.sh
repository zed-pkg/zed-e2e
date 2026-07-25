#!/usr/bin/env bash
# Tear down the in-cluster e2e. Deletes the whole kind cluster by default;
# pass --keep-cluster to only remove the zed namespace (faster re-deploys).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require kind
if [ "${1:-}" = "--keep-cluster" ]; then
  log "deleting namespace '$NAMESPACE' (keeping the cluster)"
  "${KCTL[@]}" delete namespace "$NAMESPACE" --ignore-not-found
else
  log "deleting kind cluster '$CLUSTER_NAME'"
  kind delete cluster --name "$CLUSTER_NAME"
fi
log "done"
