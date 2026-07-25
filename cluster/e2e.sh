#!/usr/bin/env bash
# Run the FULL existing e2e suite (Playwright + Puppeteer + Selenium + CLI
# lifecycle) against the CLUSTER-HOSTED servers, reusing harness/stack.ts in its
# "attach to external stack" mode.
#
# Two wrinkles the harness needs bridged for the cluster:
#   • createToken() runs the LOCAL zed-api-server binary against
#     postgres://…@127.0.0.1:55432/zed_e2e, so we port-forward the cluster
#     Postgres to 55432 (its db is named zed_e2e to match) and build that binary.
#   • the suites read ZED_E2E_API_URL / ZED_E2E_WEB_URL — pointed at the
#     host-mapped NodePorts.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require kubectl; require cargo; require npm
"${KCTL[@]}" -n "$NAMESPACE" get deploy/dd-zed-api-server >/dev/null 2>&1 \
  || die "cluster not up — run 'npm run cluster:up' first"

log "building local zed-api-server + zed binaries (harness uses them for token mint + CLI)"
( cd "$REPO_ROOT/zed-api-server.rs" && cargo build --bin zed-api-server >/dev/null )
( cd "$REPO_ROOT/zed-cli" && cargo build --bin zed >/dev/null )

log "port-forwarding cluster Postgres -> 127.0.0.1:55432 (for createToken)"
"${KCTL[@]}" -n "$NAMESPACE" port-forward svc/zed-postgres 55432:5432 >/tmp/zed-pf-pg.log 2>&1 &
PF_PID=$!
trap 'kill "$PF_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do
  (exec 3<>/dev/tcp/127.0.0.1/55432) 2>/dev/null && { exec 3>&-; break; }
  sleep 0.25
done

log "running the full e2e suite against the cluster"
ZED_E2E_API_URL="$API_URL" ZED_E2E_WEB_URL="$WEB_URL" npm --prefix "$E2E_ROOT" run e2e
log "cluster e2e complete"
