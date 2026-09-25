#!/usr/bin/env bash
set -euo pipefail

harness="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runtime="$harness/workspace/infra/modules/tenant_runtime/runtime-host"

export BMSCL_RUNTIME_BACKEND=mock
export BMSCL_RUNTIME_CONTROL_SECRET="${BMSCL_RUNTIME_CONTROL_SECRET:-0123456789abcdef0123456789abcdef}"
export BMSCL_RUNTIME_HOST_BIND=127.0.0.1:9090
export BMSCL_MOCK_GUEST_CONTROL_ADDR=127.0.0.1:9101
export BMSCL_RUNTIME_ARTIFACT_ROOT=/tmp/bmscl-runtime-artifacts
mkdir -p "$BMSCL_RUNTIME_ARTIFACT_ROOT"

exec "$runtime/target/debug/bmscl-runtime-host"
