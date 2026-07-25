#!/usr/bin/env bash
# Bring up the in-cluster e2e: kind cluster -> build+load images -> deploy the
# in-memory profile -> wait for rollouts. Idempotent; safe to re-run.
#
#   cluster/up.sh              # direct kubectl apply of the in-memory profile
#   cluster/up.sh --argocd     # also install Argo CD and deploy via app-of-apps
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require kind; require kubectl; require docker
USE_ARGOCD=0
[ "${1:-}" = "--argocd" ] && USE_ARGOCD=1

# 1. Cluster (reuse if present).
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  log "kind cluster '$CLUSTER_NAME' already exists — reusing"
else
  log "creating kind cluster '$CLUSTER_NAME'"
  kind create cluster --config "$CLUSTER_DIR/kind.yaml" --wait 90s
fi

# 2. Images (build unless already present) + load into the node.
if ! docker image inspect "$API_IMAGE" >/dev/null 2>&1 || ! docker image inspect "$WEB_IMAGE" >/dev/null 2>&1; then
  "$CLUSTER_DIR/build-images.sh"
fi
log "loading images into kind"
kind load docker-image "$API_IMAGE" "$WEB_IMAGE" --name "$CLUSTER_NAME"

# 3. Deploy.
if [ "$USE_ARGOCD" = "1" ]; then
  "$CLUSTER_DIR/argocd/install.sh"
else
  log "applying in-memory profile (kubectl apply -k)"
  "${KCTL[@]}" apply -k "$MANIFESTS_DIR"
  # A same-tag :dev reload leaves existing pods on the old image, so nudge the
  # servers to re-pull the just-loaded image. No-op on a first apply.
  "${KCTL[@]}" -n "$NAMESPACE" rollout restart deploy/dd-zed-api-server deploy/dd-zed-web-server 2>/dev/null || true
fi

# 4. Wait for rollouts.
log "waiting for Postgres + servers to become ready"
"${KCTL[@]}" -n "$NAMESPACE" rollout status deploy/zed-postgres     --timeout=120s
"${KCTL[@]}" -n "$NAMESPACE" rollout status deploy/dd-zed-api-server --timeout=120s
"${KCTL[@]}" -n "$NAMESPACE" rollout status deploy/dd-zed-web-server --timeout=120s

log "stack is live:"
log "  API  $API_URL   (healthz: $API_URL/healthz)"
log "  web  $WEB_URL"
log "Run the CLI smoke:      cluster/test-cli.sh"
log "Run the full e2e suite: ZED_E2E_API_URL=$API_URL ZED_E2E_WEB_URL=$WEB_URL npm run e2e"
