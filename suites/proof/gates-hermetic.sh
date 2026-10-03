#!/usr/bin/env bash
# Hermetic gates: everything provable on one machine with Docker + Rust + Node,
# against a locally booted registry. No public network, except G5 which needs a
# real GitHub token and is the one gate that talks to github.com.
#
# State shared between gates lives under $PROOF_ROOT (a temp dir): each gate
# writes what the next one needs, so a `--only` run of a later gate tells you
# honestly that its input is missing instead of silently inventing one.

E2E_ROOT="${E2E_ROOT:?}"
ZED_BIN="${ZED_BIN:-$E2E_ROOT/../zed-cli/target/debug/zed}"

PROOF_ORG="${PROOF_ORG:-proofco}"
PROOF_PKG="${PROOF_PKG:-tagged-lib}"
PROOF_VERSION="${PROOF_VERSION:-0.1.0}"

zed() { "$ZED_BIN" "$@"; }

# ---------------------------------------------------------------------------
# G0 — toolchain preflight
# ---------------------------------------------------------------------------
gate_register G0 "Toolchain and sibling checkouts are present"
g0() {
  local missing=()
  for c in cargo node npm git docker; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  [[ ${#missing[@]} -eq 0 ]] || gate_fail "missing tools: ${missing[*]}"
  for d in zed-cli zed-api-server.rs zed-web-server.rs; do
    [[ -d "$E2E_ROOT/../$d" ]] || gate_fail "sibling checkout ../$d not found"
  done
  docker info >/dev/null 2>&1 || gate_fail "docker daemon is not reachable"
  GATE_MSG="$(cargo --version), $(node --version), docker ok"
}

# ---------------------------------------------------------------------------
# G1 — the CLI builds from source, locked
# ---------------------------------------------------------------------------
gate_register G1 "zed CLI builds from a locked manifest"
g1() {
  require_cmd cargo || return 77
  cargo build --locked --manifest-path "$E2E_ROOT/../zed-cli/Cargo.toml" --bin zed \
    > "$PROOF_ROOT/build.log" 2>&1 || gate_fail "cargo build failed; see $PROOF_ROOT/build.log"
  [[ -x "$ZED_BIN" ]] || gate_fail "expected binary at $ZED_BIN"
  GATE_MSG="$("$ZED_BIN" --version 2>&1 | head -1)"
}

# ---------------------------------------------------------------------------
# G2 — the registry boots with authentication ON
#
# Deliberately not ZED_AUTH_DISABLED=1. The in-repo k8s base overlay currently
# ships that flag as a "TEMPORARY bootstrap posture"; a proof run that inherited
# it would be proving an unauthenticated registry, which is not the product.
# ---------------------------------------------------------------------------
gate_register G2 "Registry stack boots with bearer auth enforced"
g2() {
  require_cmd npm || return 77
  ( cd "$E2E_ROOT" && ZED_AUTH_DISABLED= npm run stack:up ) > "$PROOF_ROOT/stack.log" 2>&1 \
    || gate_fail "stack:up failed; see $PROOF_ROOT/stack.log"
  local api
  api=$(grep -o 'export ZED_E2E_API_URL=.*' "$PROOF_ROOT/stack.log" | tail -1 | cut -d= -f2-)
  [[ -n "$api" ]] || gate_fail "could not read the API URL out of stack:up output"
  printf '%s' "$api" > "$PROOF_ROOT/api_url"

  curl -fsS "$api/healthz" > /dev/null || gate_fail "$api/healthz did not answer"

  # An unauthenticated publish must be refused. If this succeeds, every other
  # gate below is meaningless.
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "$api/v1/packages/$PROOF_ORG/$PROOF_PKG/versions/$PROOF_VERSION")
  [[ "$code" == "401" || "$code" == "403" ]] \
    || gate_fail "anonymous publish returned $code; expected 401/403 (is ZED_AUTH_DISABLED set?)"

  ( cd "$E2E_ROOT" && npx tsx suites/proof/mint-token.ts proof "$PROOF_ORG" ) \
    > "$PROOF_ROOT/token" 2>"$PROOF_ROOT/token.err" || gate_fail "could not mint a publish token"
  [[ -s "$PROOF_ROOT/token" ]] || gate_fail "minted token was empty"
  GATE_MSG="api at $api, anonymous publish refused with $code"
}

# ---------------------------------------------------------------------------
# G3 — publish with real VCS provenance, no --skip-vcs-checks
#
# Every existing e2e publish passes --skip-vcs-checks (harness/fixtures.ts),
# so vcs.rs::verify_publish_provenance — the code behind "your git tag is the
# source of truth" — has never run in an integration test. This gate builds a
# real repository with a real annotated tag at HEAD and publishes from it.
# ---------------------------------------------------------------------------
gate_register G3 "Publish verifies a real git tag at HEAD (no --skip-vcs-checks)"
g3() {
  local api; api=$(cat "$PROOF_ROOT/api_url" 2>/dev/null) || gate_skip "G2 did not run"
  [[ -n "$api" ]] || gate_skip "G2 did not run"
  local token; token=$(cat "$PROOF_ROOT/token")

  local repo="$PROOF_ROOT/fixture-repo"
  mkdir -p "$repo/src"
  cat > "$repo/.zpkg.toml" <<TOML
[package]
org = "$PROOF_ORG"
name = "$PROOF_PKG"
version = "$PROOF_VERSION"
description = "Proof fixture published from a real annotated tag"
license = "MIT"

[package.repository]
vcs = "git"
url = "https://github.com/${PROOF_FORGE_REPO:-$PROOF_ORG/$PROOF_PKG}"
TOML
  printf 'MIT\n' > "$repo/LICENSE"
  printf 'module.exports = "%s";\n' "$PROOF_PKG" > "$repo/src/index.js"

  git -C "$repo" init -q
  git -C "$repo" config user.email proof@zpkg.net
  git -C "$repo" config user.name "zed proof"
  git -C "$repo" add .zpkg.toml LICENSE src/index.js
  git -C "$repo" commit -qm "proof fixture"
  git -C "$repo" tag -a "v$PROOF_VERSION" -m "v$PROOF_VERSION"

  local head_commit; head_commit=$(git -C "$repo" rev-parse HEAD)
  printf '%s' "$head_commit" > "$PROOF_ROOT/head_commit"

  # No --skip-vcs-checks, no --allow-dirty. This is the point of the gate.
  ( cd "$repo" && ZED_PKG_REGISTRY="$api" ZED_PKG_TOKEN="$token" \
      "$ZED_BIN" publish ) > "$PROOF_ROOT/publish.log" 2>&1 \
    || gate_fail "tag-verified publish failed; see $PROOF_ROOT/publish.log"

  local meta; meta=$(curl -fsS "$api/v1/packages/$PROOF_ORG/$PROOF_PKG/versions/$PROOF_VERSION") \
    || gate_fail "registry did not serve the version it just accepted"
  printf '%s' "$meta" > "$PROOF_ROOT/version.json"
  grep -q "$head_commit" <<<"$meta" \
    || gate_fail "version metadata does not carry the tagged commit $head_commit"
  grep -q "v$PROOF_VERSION" <<<"$meta" \
    || gate_fail "version metadata does not carry the tag v$PROOF_VERSION"

  local sha; sha=$(sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([a-f0-9]\{64\}\)".*/\1/p' <<<"$meta" | head -1)
  [[ -n "$sha" ]] || gate_fail "no sha256 in version metadata"
  printf '%s' "$sha" > "$PROOF_ROOT/sha256"

  # A tag that does not point at HEAD must be refused, or the check is cosmetic.
  printf '// drift\n' >> "$repo/src/index.js"
  git -C "$repo" add src/index.js
  git -C "$repo" commit -qm "move HEAD past the tag"
  if ( cd "$repo" && ZED_PKG_REGISTRY="$api" ZED_PKG_TOKEN="$token" \
        "$ZED_BIN" publish --dry-run ) >"$PROOF_ROOT/publish-drift.log" 2>&1; then
    gate_fail "publish succeeded with HEAD ahead of the tag; provenance is not enforced"
  fi
  git -C "$repo" reset -q --hard "v$PROOF_VERSION"
  GATE_MSG="published $PROOF_ORG/$PROOF_PKG@$PROOF_VERSION at tag v$PROOF_VERSION (${head_commit:0:12}), drift refused"
}

# ---------------------------------------------------------------------------
# G4 — publisher key lifecycle and the signed index
# ---------------------------------------------------------------------------
gate_register G4 "Publisher key generates, enrolls, and signs a verifiable index"
g4() {
  local api; api=$(cat "$PROOF_ROOT/api_url" 2>/dev/null) || gate_skip "G2 did not run"
  [[ -s "$PROOF_ROOT/sha256" ]] || gate_skip "G3 did not publish anything to index"
  local token; token=$(cat "$PROOF_ROOT/token")
  export ZED_PKG_HOME="$PROOF_ROOT/home-publisher"
  mkdir -p "$ZED_PKG_HOME"

  ZED_PKG_REGISTRY="$api" "$ZED_BIN" key generate --org "$PROOF_ORG" --key-id proof-2026 \
    > "$PROOF_ROOT/key-generate.log" 2>&1 || gate_fail "zed key generate failed"
  ZED_PKG_REGISTRY="$api" ZED_PKG_TOKEN="$token" \
    "$ZED_BIN" key enroll --org "$PROOF_ORG" --key-id proof-2026 \
    > "$PROOF_ROOT/key-enroll.log" 2>&1 || gate_fail "zed key enroll failed"

  curl -fsS "$api/v1/orgs/$PROOF_ORG/keys" > "$PROOF_ROOT/keys.json" \
    || gate_fail "registry does not serve the org key set"
  grep -q "proof-2026" "$PROOF_ROOT/keys.json" || gate_fail "enrolled key id is not in the key set"

  ( cd "$PROOF_ROOT/fixture-repo" && ZED_PKG_REGISTRY="$api" ZED_PKG_TOKEN="$token" \
      "$ZED_BIN" mirror publish-index ) > "$PROOF_ROOT/publish-index.log" 2>&1 \
    || gate_fail "zed mirror publish-index failed; see $PROOF_ROOT/publish-index.log"

  curl -fsS "$api/v1/packages/$PROOF_ORG/$PROOF_PKG/signed-index" > "$PROOF_ROOT/signed-index.json" \
    || gate_fail "registry does not serve a signed index for the package"
  grep -q '"signature"' "$PROOF_ROOT/signed-index.json" \
    || gate_fail "signed index carries no signature field"
  GATE_MSG="key proof-2026 enrolled; signed index served"
}

# ---------------------------------------------------------------------------
# G5 — the GitHub forge mirror actually receives the artifact
#
# forge_publish.rs uploads `zpkg-<sha256>.tar.gz` + `zpkg-version.json` to the
# release for the version's tag, and refreshes a rolling `zpkg-index` release.
# Today that path is best-effort inside `zed publish` (its failures are printed
# as warnings, never propagated) and has no integration coverage at all — so
# "zed-pkg is backed by GitHub" is, as of this writing, an untested claim.
#
# Needs a real token and a real repository. Set:
#   ZED_PKG_GITHUB_TOKEN=<token with contents:write on the fixture repo>
#   PROOF_FORGE_REPO=zed-pkg-test/zpkg-proof-fixture
# ---------------------------------------------------------------------------
gate_register G5 "Publish mirrors the artifact to GitHub releases, digest-matched"
g5() {
  [[ -n "${ZED_PKG_GITHUB_TOKEN:-}" ]] || gate_skip "ZED_PKG_GITHUB_TOKEN is not set"
  [[ -n "${PROOF_FORGE_REPO:-}" ]] || gate_skip "PROOF_FORGE_REPO is not set (owner/repo)"
  [[ -s "$PROOF_ROOT/sha256" ]] || gate_skip "G3 did not publish an artifact"
  local sha; sha=$(cat "$PROOF_ROOT/sha256")

  local rel
  rel=$(curl -fsS -H "Authorization: Bearer $ZED_PKG_GITHUB_TOKEN" \
    "https://api.github.com/repos/$PROOF_FORGE_REPO/releases/tags/v$PROOF_VERSION") \
    || gate_fail "no GitHub release for tag v$PROOF_VERSION in $PROOF_FORGE_REPO"
  printf '%s' "$rel" > "$PROOF_ROOT/forge-release.json"

  grep -q "zpkg-$sha.tar.gz" <<<"$rel" \
    || gate_fail "release has no asset named zpkg-$sha.tar.gz (the registry's digest)"
  grep -q "zpkg-version.json" <<<"$rel" \
    || gate_fail "release carries the artifact but no zpkg-version.json metadata"

  # The bytes on the forge must hash to the same digest the registry recorded,
  # or the fallback would serve a different package under the same pin.
  local url
  url=$(sed -n 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*zpkg-'"$sha"'\.tar\.gz\)".*/\1/p' <<<"$rel" | head -1)
  [[ -n "$url" ]] || gate_fail "could not read the asset download URL out of the release"
  curl -fsSL -H "Authorization: Bearer $ZED_PKG_GITHUB_TOKEN" "$url" -o "$PROOF_ROOT/forge-artifact.tar.gz" \
    || gate_fail "release asset would not download"
  local got; got=$(sha256_of "$PROOF_ROOT/forge-artifact.tar.gz")
  [[ "$got" == "$sha" ]] || gate_fail "forge asset hashes to $got, registry says $sha"

  local idx
  idx=$(curl -fsS -H "Authorization: Bearer $ZED_PKG_GITHUB_TOKEN" \
    "https://api.github.com/repos/$PROOF_FORGE_REPO/releases/tags/zpkg-index" 2>/dev/null) \
    || gate_fail "rolling zpkg-index release is missing; mirror resolution cannot bootstrap"
  grep -q "zpkg-index-$PROOF_ORG-$PROOF_PKG.json" <<<"$idx" \
    || gate_fail "zpkg-index release has no index asset for $PROOF_ORG/$PROOF_PKG"
  GATE_MSG="forge asset digest matches registry ($sha), index asset present"
}

# ---------------------------------------------------------------------------
# G6 — the mirror bootstrap document is served, and says something true
# ---------------------------------------------------------------------------
gate_register G6 "Registry serves /.well-known/zpkg-mirrors.json and the CLI reads it"
g6() {
  local api; api=$(cat "$PROOF_ROOT/api_url" 2>/dev/null) || gate_skip "G2 did not run"
  curl -fsS "$api/.well-known/zpkg-mirrors.json" > "$PROOF_ROOT/mirrors.json" \
    || gate_fail "registry does not serve the mirror bootstrap document"
  grep -q '"kind"' "$PROOF_ROOT/mirrors.json" || gate_fail "bootstrap document has no mirror entries"
  ZED_PKG_REGISTRY="$api" "$ZED_BIN" mirror bootstrap --url "$api" \
    > "$PROOF_ROOT/mirror-bootstrap.log" 2>&1 \
    || gate_fail "zed mirror bootstrap could not parse what the registry served"
  GATE_MSG="bootstrap document served and parsed by the CLI"
}

# ---------------------------------------------------------------------------
# G7 — the registry goes away and the install still works
#
# This is the claim that matters most and is proven nowhere today: an install
# pinned by .zpkg.lock must complete from a mirror, into an empty store, with
# the registry unreachable, and the bytes must hash to the pin.
# ---------------------------------------------------------------------------
gate_register G7 "Install completes from a mirror with the registry unreachable"
g7() {
  local api; api=$(cat "$PROOF_ROOT/api_url" 2>/dev/null) || gate_skip "G2 did not run"
  [[ -s "$PROOF_ROOT/sha256" ]] || gate_skip "G3 did not publish an artifact"
  local token; token=$(cat "$PROOF_ROOT/token")
  local sha; sha=$(cat "$PROOF_ROOT/sha256")

  # A consumer project that depends on the published package.
  local consumer="$PROOF_ROOT/consumer"
  mkdir -p "$consumer"
  cat > "$consumer/.zpkg.toml" <<TOML
[package]
org = "$PROOF_ORG"
name = "consumer"
version = "0.0.1"
license = "MIT"

[package.repository]
vcs = "git"
url = "https://github.com/$PROOF_ORG/consumer"

[dependencies]
"$PROOF_ORG/$PROOF_PKG" = "$PROOF_VERSION"
TOML

  ( cd "$consumer" && ZED_PKG_REGISTRY="$api" ZED_PKG_HOME="$PROOF_ROOT/home-warm" \
      "$ZED_BIN" install ) > "$PROOF_ROOT/install-warm.log" 2>&1 \
    || gate_fail "baseline install against a healthy registry failed"
  grep -q "$sha" "$consumer/.zpkg.lock" || gate_fail "lockfile does not pin $sha"

  # Build a complete offline mirror of everything the lock pins, then declare it.
  ( cd "$consumer" && ZED_PKG_REGISTRY="$api" ZED_PKG_HOME="$PROOF_ROOT/home-warm" \
      "$ZED_BIN" mirror sync --output "$PROOF_ROOT/offline-mirror" ) \
    > "$PROOF_ROOT/mirror-sync.log" 2>&1 || gate_fail "zed mirror sync failed"
  cat >> "$consumer/.zpkg.toml" <<TOML

[[mirror]]
kind = "directory"
id = "proof-offline"
path = "$PROOF_ROOT/offline-mirror"
priority = 10
TOML

  # Registry blackholed: a port nothing listens on. Store empty. Frozen replay.
  local dead="http://127.0.0.1:9"
  ( cd "$consumer" && ZED_PKG_REGISTRY="$dead" ZED_PKG_HOME="$PROOF_ROOT/home-cold" \
      "$ZED_BIN" install --frozen ) > "$PROOF_ROOT/install-cold.log" 2>&1 \
    || gate_fail "install --frozen failed with the registry down; see $PROOF_ROOT/install-cold.log"

  local linked="$consumer/zed_modules/$PROOF_ORG/$PROOF_PKG"
  [[ -e "$linked" ]] || gate_fail "package was not materialized at zed_modules/$PROOF_ORG/$PROOF_PKG"
  grep -rq "$sha" "$PROOF_ROOT/home-cold" 2>/dev/null \
    || gate_fail "cold store holds no artifact under the pinned digest"
  GATE_MSG="frozen install served entirely from the directory mirror, digest $sha"
}

# ---------------------------------------------------------------------------
# G8 — a mirror that lies is caught
#
# The fallback is only safe because the pin is the authority. Prove it: corrupt
# the mirrored bytes and require the install to fail rather than accept them.
# ---------------------------------------------------------------------------
gate_register G8 "A tampered mirror artifact is rejected, not installed"
g8() {
  [[ -d "$PROOF_ROOT/offline-mirror" ]] || gate_skip "G7 did not build a mirror"
  local consumer="$PROOF_ROOT/consumer"
  local victim
  victim=$(find "$PROOF_ROOT/offline-mirror" -name '*.tar.gz' | head -1)
  [[ -n "$victim" ]] || gate_fail "no artifact found in the offline mirror"

  printf 'tampered\n' >> "$victim"
  local dead="http://127.0.0.1:9"
  if ( cd "$consumer" && ZED_PKG_REGISTRY="$dead" ZED_PKG_HOME="$PROOF_ROOT/home-tamper" \
        "$ZED_BIN" install --frozen ) > "$PROOF_ROOT/install-tamper.log" 2>&1; then
    gate_fail "install accepted an artifact whose bytes do not match the lock pin"
  fi
  grep -qiE "mismatch|integrity|sha256" "$PROOF_ROOT/install-tamper.log" \
    || gate_fail "install failed, but not with an integrity error — check why"
  GATE_MSG="tampered artifact rejected with an integrity error"
}

# ---------------------------------------------------------------------------
# G9 — clean-room reproducibility
# ---------------------------------------------------------------------------
gate_register G9 "A clean machine reproduces the same closure byte for byte"
g9() {
  local api; api=$(cat "$PROOF_ROOT/api_url" 2>/dev/null) || gate_skip "G2 did not run"
  local consumer="$PROOF_ROOT/consumer"
  [[ -f "$consumer/.zpkg.lock" ]] || gate_skip "G7 did not produce a lockfile"

  local before; before=$(sha256_of "$consumer/.zpkg.lock")
  local clean="$PROOF_ROOT/cleanroom"
  mkdir -p "$clean"
  cp "$consumer/.zpkg.toml" "$consumer/.zpkg.lock" "$clean/"
  ( cd "$clean" && ZED_PKG_REGISTRY="$api" ZED_PKG_HOME="$PROOF_ROOT/home-clean" \
      "$ZED_BIN" install --frozen ) > "$PROOF_ROOT/install-clean.log" 2>&1 \
    || gate_fail "frozen install in an empty store failed"
  local after; after=$(sha256_of "$clean/.zpkg.lock")
  [[ "$before" == "$after" ]] || gate_fail "frozen install rewrote the lockfile ($before -> $after)"

  # Repacking the same tree must reproduce the published digest.
  local sha; sha=$(cat "$PROOF_ROOT/sha256")
  ( cd "$PROOF_ROOT/fixture-repo" && "$ZED_BIN" pack --out "$PROOF_ROOT/repack" ) \
    > "$PROOF_ROOT/repack.log" 2>&1 || gate_fail "zed pack failed on the fixture repo"
  local repacked
  repacked=$(find "$PROOF_ROOT/repack" -name '*.tar.gz' | head -1)
  [[ -n "$repacked" ]] || gate_fail "pack produced no archive"
  local got; got=$(sha256_of "$repacked")
  [[ "$got" == "$sha" ]] || gate_fail "repack digest $got != published digest $sha (pack is not deterministic)"
  GATE_MSG="lockfile stable, repack reproduces $sha"
}

# ---------------------------------------------------------------------------
# G10 — the two migration paths describe the same database
#
# zed-pkg maintains a declarative desired state (schema/schema.sql, applied with
# dpm from declarative-migrations, in the k8s-libs-and-shared-defs pg-defs
# style) *and* an imperative SeaORM `migration/` crate that runs on boot. Two
# descriptions of one schema drift the moment nobody is diffing them, and the
# drift only shows up as a runtime error against whichever one production used.
#
# So: migrate the database the imperative way (G2 already did, via
# AUTO_MIGRATE), then ask dpm for the diff against the declarative source. An
# empty diff is the proof that the ORM's applied schema and the desired-state
# contract are the same schema. A non-empty diff IS the generated migration —
# which is the workflow the house wants: diff the live database against what
# the ORM generates, and let the diff be the migration.
# ---------------------------------------------------------------------------
gate_register G10 "The ORM-applied schema and the declarative contract agree"
g10() {
  require_cmd dpm "dpm is not installed (brew install declarative-migrations/tap/dpm)" || return 77
  [[ -s "$PROOF_ROOT/api_url" ]] || gate_skip "G2 did not migrate a database"
  local api_repo="$E2E_ROOT/../zed-api-server.rs"
  [[ -x "$api_repo/schema/dpm.sh" ]] || gate_skip "schema/dpm.sh not found in ../zed-api-server.rs"

  # The stack's own database, migrated on boot by the SeaORM crate.
  local pg_port target
  pg_port=$(sed -n 's/.*127\.0\.0\.1:\([0-9]*\)\/zed_e2e.*/\1/p' "$PROOF_ROOT/stack.log" | head -1)
  target="${PROOF_TARGET_DATABASE_URL:-postgres://zed:zed@127.0.0.1:${pg_port:-5432}/zed_e2e}"
  # dpm materializes schema.sql on a shadow server; never production, and it
  # must carry pgvector + pg_trgm (the pgvector/pgvector:pg16 image does).
  local shadow="${SHADOW_DATABASE_URL:-postgres://zed:zed@127.0.0.1:${pg_port:-5432}/postgres}"

  TARGET_DATABASE_URL="$target" SHADOW_DATABASE_URL="$shadow" \
    bash "$api_repo/schema/dpm.sh" diff --out "$PROOF_ROOT/schema-drift.sql" \
    > "$PROOF_ROOT/dpm-diff.log" 2>&1 \
    || gate_fail "dpm diff failed; see $PROOF_ROOT/dpm-diff.log"

  # Comments and blank lines are dpm's own annotation, including the
  # commented-out destructive statements it deliberately refuses to run.
  local statements
  statements=$(grep -cvE '^\s*(--.*)?$' "$PROOF_ROOT/schema-drift.sql" 2>/dev/null || echo 0)
  if [[ "$statements" -ne 0 ]]; then
    gate_fail "the migrated database differs from schema.sql by $statements statement(s); the generated migration is at $PROOF_ROOT/schema-drift.sql"
  fi
  GATE_MSG="dpm diff is empty: the SeaORM-applied schema matches schema/schema.sql"
}
