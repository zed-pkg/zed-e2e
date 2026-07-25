#!/usr/bin/env bash
# Install Argo CD into the kind cluster and deploy the zed-pkg in-memory stack
# through the app-of-apps. This is the GitOps path: Argo CD pulls the overlay
# from GitHub (repoURL/targetRevision in cluster/argocd/*.yaml), so THIS branch
# of zed-e2e must be pushed before the root app can sync.
#
# Invoked by `cluster/up.sh --argocd`; can also be run directly once a cluster
# and loaded images exist.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require kubectl
ARGOCD_VERSION="${ARGOCD_VERSION:-stable}"   # pin to a tag for reproducibility
ARGOCD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Install Argo CD.
if ! "${KCTL[@]}" get ns argocd >/dev/null 2>&1; then
  log "installing Argo CD ($ARGOCD_VERSION) into namespace argocd"
  "${KCTL[@]}" create namespace argocd
  "${KCTL[@]}" apply -n argocd \
    -f "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml"
else
  log "Argo CD namespace already present — reusing"
fi

log "waiting for Argo CD control plane to be ready"
for d in argocd-repo-server argocd-server argocd-application-controller; do
  # application-controller is a StatefulSet; try both kinds.
  "${KCTL[@]}" -n argocd rollout status "deploy/$d" --timeout=180s 2>/dev/null \
    || "${KCTL[@]}" -n argocd rollout status "statefulset/$d" --timeout=180s
done

# 2. Register the project + app-of-apps.
log "applying AppProject + app-of-apps root"
"${KCTL[@]}" apply -f "$ARGOCD_DIR/project.yaml"
"${KCTL[@]}" apply -f "$ARGOCD_DIR/app-of-apps.yaml"

# 3. Wait for the child app to sync + go healthy.
log "waiting for the zed-inmemory Application to sync (Argo CD pulls from GitHub)"
deadline=$(( $(date +%s) + 300 ))
while :; do
  sync="$("${KCTL[@]}" -n argocd get application zed-inmemory -o jsonpath='{.status.sync.status}' 2>/dev/null || true)"
  health="$("${KCTL[@]}" -n argocd get application zed-inmemory -o jsonpath='{.status.health.status}' 2>/dev/null || true)"
  log "  zed-inmemory: sync=${sync:-<pending>} health=${health:-<pending>}"
  [ "$sync" = "Synced" ] && [ "$health" = "Healthy" ] && break
  [ "$(date +%s)" -ge "$deadline" ] && die "zed-inmemory did not reach Synced/Healthy in time (sync=$sync health=$health)"
  sleep 6
done

log "Argo CD app-of-apps is Synced + Healthy. Applications:"
"${KCTL[@]}" -n argocd get applications
