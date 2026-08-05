#!/usr/bin/env bash
set -euo pipefail

: "${ZED_BIN:?set ZED_BIN to the zed executable under test}"
[[ -x "$ZED_BIN" ]] || {
  printf 'ZED_BIN is not executable: %s\n' "$ZED_BIN" >&2
  exit 2
}

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
export HOME="$ROOT/home"
export ZED_PKG_HOME="$ROOT/zed-pkg-home"
mkdir -p "$HOME" "$ZED_PKG_HOME" "$ROOT/logs"

fail() {
  printf 'nested pack publication-boundary E2E failed: %s\n' "$*" >&2
  exit 1
}

write_manifest() {
  local fixture="$1"
  local name="$2"
  cat >"$fixture/.zpkg.toml" <<EOF
[package]
org = "zed-e2e"
name = "$name"
version = "1.2.3"

[package.repository]
vcs = "git"
url = "https://example.invalid/zed-e2e/$name.git"
EOF
}

commit_all() {
  local worktree="$1"
  local message="$2"
  git -C "$worktree" add -- .
  git -C "$worktree" \
    -c user.name='Zed E2E' \
    -c user.email='zed-e2e@example.invalid' \
    commit -qm "$message"
}

run_pack() {
  local fixture="$1"
  local stdout="$2"
  local stderr="$3"
  (cd "$fixture" && "$ZED_BIN" pack >"$stdout" 2>"$stderr")
}

expect_reviewed_generated_input() {
  local name='reviewed-generated-input'
  local fixture="$ROOT/$name"
  mkdir -p "$fixture"
  write_manifest "$fixture" "$name"
  printf 'generated.wasm\n' >"$fixture/.gitignore"
  printf 'generated.wasm\n' >"$fixture/.zedinclude"
  printf 'runtime\n' >"$fixture/payload.txt"
  git -C "$fixture" init -q
  commit_all "$fixture" 'review generated input policy'
  printf 'generated artifact\n' >"$fixture/generated.wasm"

  local stdout="$ROOT/logs/$name.stdout"
  local stderr="$ROOT/logs/$name.stderr"
  if ! run_pack "$fixture" "$stdout" "$stderr"; then
    cat "$stdout" >&2 || true
    cat "$stderr" >&2 || true
    fail 'tracked and clean .zedinclude did not admit the generated file'
  fi

  local archive
  archive="$(find "$fixture/.zed/pack" -maxdepth 1 -type f -name '*.tar.gz' -print -quit)"
  [[ -n "$archive" ]] || fail 'reviewed generated input did not produce an archive'
  local listing="$ROOT/logs/$name.archive.list"
  tar -tzf "$archive" >"$listing"
  grep -Fxq 'pkg/generated.wasm' "$listing" || {
    cat "$listing" >&2
    fail 'reviewed generated input was absent from the archive'
  }
  if grep -Fq '.zedinclude' "$listing"; then
    cat "$listing" >&2
    fail '.zedinclude control metadata entered the archive'
  fi
}

expect_dirty_allowlist_rejected() {
  local name='dirty-generated-input-policy'
  local fixture="$ROOT/$name"
  mkdir -p "$fixture"
  write_manifest "$fixture" "$name"
  printf 'generated.wasm\n' >"$fixture/.gitignore"
  printf 'generated.wasm\n' >"$fixture/.zedinclude"
  git -C "$fixture" init -q
  commit_all "$fixture" 'track generated input policy'
  printf '**\n' >"$fixture/.zedinclude"
  printf 'generated artifact\n' >"$fixture/generated.wasm"

  local stdout="$ROOT/logs/$name.stdout"
  local stderr="$ROOT/logs/$name.stderr"
  if run_pack "$fixture" "$stdout" "$stderr"; then
    fail 'dirty .zedinclude unexpectedly relaxed the publication boundary'
  fi
  grep -Fq 'committed and clean' "$stderr" || {
    cat "$stderr" >&2
    fail 'dirty .zedinclude rejection did not explain the review requirement'
  }
}

expect_overbroad_allowlist_rejected() {
  local name='overbroad-generated-input-policy'
  local fixture="$ROOT/$name"
  mkdir -p "$fixture"
  write_manifest "$fixture" "$name"
  printf 'generated.wasm\n' >"$fixture/.gitignore"
  printf '**\n' >"$fixture/.zedinclude"
  git -C "$fixture" init -q
  commit_all "$fixture" 'track overbroad generated input policy'
  printf 'generated artifact\n' >"$fixture/generated.wasm"

  local stdout="$ROOT/logs/$name.stdout"
  local stderr="$ROOT/logs/$name.stderr"
  if run_pack "$fixture" "$stdout" "$stderr"; then
    fail 'project-wide .zedinclude unexpectedly relaxed the publication boundary'
  fi
  grep -Fq 'bounded file or directory' "$stderr" || {
    cat "$stderr" >&2
    fail 'overbroad .zedinclude rejection did not explain the bounded-pattern rule'
  }
}

expect_submodule_ignored_input_rejected() {
  local name='ignored-submodule-input'
  local child="$ROOT/$name-child"
  local fixture="$ROOT/$name"
  mkdir -p "$child" "$fixture"

  git -C "$child" init -q
  printf 'private.env\n' >"$child/.gitignore"
  printf 'nested runtime\n' >"$child/lib.txt"
  commit_all "$child" 'child baseline'

  write_manifest "$fixture" "$name"
  printf 'root runtime\n' >"$fixture/payload.txt"
  git -C "$fixture" init -q
  git -C "$fixture" -c protocol.file.allow=always submodule add -q "$child" vendor/client
  commit_all "$fixture" 'root with submodule'
  printf 'TOKEN=synthetic-submodule-secret\n' >"$fixture/vendor/client/private.env"

  local stdout="$ROOT/logs/$name.stdout"
  local stderr="$ROOT/logs/$name.stderr"
  if run_pack "$fixture" "$stdout" "$stderr"; then
    fail 'ignored submodule input unexpectedly entered packaging'
  fi
  grep -Fq 'vendor/client/private.env' "$stderr" || {
    cat "$stderr" >&2
    fail 'submodule rejection did not identify the nested ignored path'
  }
}

expect_polyglot_root_legal_input_rejected() {
  local name='ignored-polyglot-root-legal-input'
  local fixture="$ROOT/$name"
  mkdir -p "$fixture/clients/ts"
  write_manifest "$fixture" "$name"
  cat >>"$fixture/.zpkg.toml" <<'EOF'

[targets.nodejs]
dir = "clients/ts"
adapter = "node"
EOF
  printf 'NOTICE.private\n' >"$fixture/.gitignore"
  printf '{"name":"zed-e2e-polyglot"}\n' >"$fixture/clients/ts/package.json"
  git -C "$fixture" init -q
  commit_all "$fixture" 'polyglot baseline'
  printf 'TOKEN=synthetic-root-legal-secret\n' >"$fixture/NOTICE.private"

  local stdout="$ROOT/logs/$name.stdout"
  local stderr="$ROOT/logs/$name.stderr"
  if run_pack "$fixture" "$stdout" "$stderr"; then
    fail 'ignored root legal file unexpectedly entered a polyglot target'
  fi
  grep -Fq 'NOTICE.private' "$stderr" || {
    cat "$stderr" >&2
    fail 'polyglot legal-file rejection did not identify the ignored file'
  }
  grep -Fq 'root legal-file copy' "$stderr" || {
    cat "$stderr" >&2
    fail 'polyglot legal-file rejection did not identify the copy path'
  }
}

expect_reviewed_generated_input
expect_dirty_allowlist_rejected
expect_overbroad_allowlist_rejected
expect_submodule_ignored_input_rejected
expect_polyglot_root_legal_input_rejected

printf 'nested pack publication-boundary E2E passed\n'
