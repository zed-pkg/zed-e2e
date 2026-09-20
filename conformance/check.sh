#!/usr/bin/env sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
cd "$repo_root"

[ -d contracts ] && [ ! -L contracts ] || {
  echo 'conformance: contracts/ must be a real non-symlink directory' >&2
  exit 1
}
[ -d conformance ] && [ ! -L conformance ] || {
  echo 'conformance: conformance/ must be a real non-symlink directory' >&2
  exit 1
}
[ -f package-lock.json ] || {
  echo 'conformance: package-lock.json is required for reproducible E2E admission' >&2
  exit 1
}

npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run test:harness
