#!/usr/bin/env bash
set -euo pipefail

harness="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
api="$harness/workspace/api"

export BMSCL_BIND=127.0.0.1:8081
export BMSCL_AUTH_INTROSPECTION_URL=http://127.0.0.1:9191/introspect
export BMSCL_SECURITY_STATE_URL=http://127.0.0.1:9191/security-state
export BMSCL_SECURITY_STATE_SERVICE_TOKEN_FILE="$harness/security_state_token"
export BMSCL_RUNTIME_CONTROL_SECRET="${BMSCL_RUNTIME_CONTROL_SECRET:-0123456789abcdef0123456789abcdef}"
export BMSCL_RUNTIME_HOSTS_FIRECRACKER=http://127.0.0.1:9090
export BMSCL_RUNTIME_HOSTS_FAAS=http://127.0.0.1:9090
export RUST_LOG=info

exec "$api/target/debug/bmscl-api-server"
