#!/usr/bin/env bash
# End-to-end zed CLI smoke against the CLUSTER-HOSTED registry (no browser deps).
#
# Exercises the real publish lifecycle the way harness/fixtures.ts does, but the
# token is minted INSIDE the cluster (kubectl exec into the api pod, which holds
# DATABASE_URL) so it is valid against the in-cluster Postgres, and the CLI talks
# to the api server through the host-mapped NodePort.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require kubectl; require cargo
ORG="clitest"
PKG="widget-kit"
VER="1.4.2"

log "building the zed CLI (debug)"
( cd "$REPO_ROOT/zed-cli" && cargo build --bin zed >/dev/null )
ZED_BIN="$REPO_ROOT/zed-cli/target/debug/zed"
[ -x "$ZED_BIN" ] || die "zed binary not found at $ZED_BIN"

log "minting an org-scoped token inside the cluster (create-token --org $ORG)"
RAW="$("${KCTL[@]}" -n "$NAMESPACE" exec deploy/dd-zed-api-server -- \
        zed-api-server create-token --name cli-smoke --org "$ORG" 2>/dev/null)"
TOKEN="$(printf '%s\n' "$RAW" | grep -oE 'zpkg_[A-Za-z0-9_]+' | tail -n1)"
[ -n "$TOKEN" ] || die "could not parse a zpkg_ token from create-token output:\n$RAW"

HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/zed-cli-home.XXXXXX")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/zed-cli-work.XXXXXX")"
trap 'rm -rf "$HOME_DIR" "$WORK"' EXIT
export ZED_PKG_HOME="$HOME_DIR"
export ZED_PKG_REGISTRY="$API_URL"
export ZED_PKG_TOKEN="$TOKEN"

zed() { "$ZED_BIN" "$@"; }
pass() { printf '\033[1;32m  PASS\033[0m %s\n' "$*"; }

# 1. publish -----------------------------------------------------------------
PKG_DIR="$WORK/$PKG"
mkdir -p "$PKG_DIR/src"
cat > "$PKG_DIR/.zpkg.toml" <<EOF
[package]
org = "$ORG"
name = "$PKG"
version = "$VER"
description = "cluster CLI smoke fixture"
license = "MIT"

[package.repository]
vcs = "git"
url = "https://github.com/$ORG/$PKG"
EOF
printf 'MIT\n' > "$PKG_DIR/LICENSE"
printf 'module.exports = "%s";\n' "$PKG" > "$PKG_DIR/src/index.js"

log "zed publish"
( cd "$PKG_DIR" && zed publish --skip-vcs-checks ) || die "publish failed"
pass "published $ORG/$PKG@$VER"

# 2. immutability: re-publishing the same version must be rejected -----------
if ( cd "$PKG_DIR" && zed publish --skip-vcs-checks ) 2>/dev/null; then
  die "re-publishing an existing version should have failed (versions are immutable)"
fi
pass "duplicate publish correctly rejected (immutable versions)"

# 3. find --------------------------------------------------------------------
log "zed find $PKG"
FOUND="$(zed find "$PKG" 2>&1 || true)"
printf '%s\n' "$FOUND" | grep -q "$PKG" || die "find did not list $PKG:\n$FOUND"
pass "find lists $ORG/$PKG"

# 4. install into a consumer -------------------------------------------------
CONSUMER="$WORK/consumer"
mkdir -p "$CONSUMER"
cat > "$CONSUMER/.zpkg.toml" <<EOF
[package]
org = "$ORG"
name = "consumer-app"
version = "0.1.0"
license = "MIT"

[package.repository]
vcs = "git"
url = "https://github.com/$ORG/consumer-app"

[dependencies]
"$ORG/$PKG" = "$VER"
EOF
log "zed install (consumer -> $ORG/$PKG@$VER)"
( cd "$CONSUMER" && zed install ) || die "install failed"
[ -e "$CONSUMER/zed_modules" ] || die "install did not create zed_modules/"
[ -f "$CONSUMER/.zpkg.lock" ] || die "install did not write .zpkg.lock"
grep -q "$PKG" "$CONSUMER/.zpkg.lock" || die ".zpkg.lock does not mention $PKG"
pass "install materialized zed_modules/ + pinned .zpkg.lock"

# 5. yank hides the version from fresh resolution ----------------------------
log "zed yank $ORG/$PKG@$VER"
( cd "$PKG_DIR" && zed yank "$ORG/$PKG@$VER" ) || die "yank failed"
FRESH="$(mktemp -d "${TMPDIR:-/tmp}/zed-cli-fresh.XXXXXX")"
cat > "$FRESH/.zpkg.toml" <<EOF
[package]
org = "$ORG"
name = "after-yank"
version = "0.1.0"
license = "MIT"

[dependencies]
"$ORG/$PKG" = "$VER"
EOF
if ( cd "$FRESH" && ZED_PKG_HOME="$(mktemp -d)" zed install ) 2>/dev/null; then
  die "install of a yanked version should fail on a fresh resolution"
fi
rm -rf "$FRESH"
pass "yanked version is hidden from fresh resolution"

printf '\n\033[1;32mAll CLI smoke checks passed against the cluster registry.\033[0m\n'
