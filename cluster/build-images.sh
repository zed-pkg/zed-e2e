#!/usr/bin/env bash
# Build the two server images from a CLEAN, source-only context.
#
# Both Dockerfiles need the parent dir as build context (the ../zed-interfaces
# path dependency), but the live repos carry multi-GB target/ dirs and there is
# no .dockerignore, so a naive `docker build <parent>` ships gigabytes to the
# daemon. We stage a throwaway context with just the three source trees.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require docker
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/zed-build-ctx.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

for repo in zed-interfaces zed-api-server.rs zed-web-server.rs; do
  [ -d "$REPO_ROOT/$repo" ] || die "expected sibling checkout $REPO_ROOT/$repo"
  rsync -a --exclude=target --exclude=.git --exclude=node_modules "$REPO_ROOT/$repo" "$STAGE/"
done

log "building $API_IMAGE"
docker build -f "$STAGE/zed-api-server.rs/Dockerfile" -t "$API_IMAGE" "$STAGE"
log "building $WEB_IMAGE"
docker build -f "$STAGE/zed-web-server.rs/Dockerfile" -t "$WEB_IMAGE" "$STAGE"
log "images built"
