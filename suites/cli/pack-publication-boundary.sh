#!/usr/bin/env bash
set -euo pipefail

: "${ZED_BIN:?set ZED_BIN to the zed executable under test}"
if [[ ! -x "$ZED_BIN" ]]; then
  printf 'ZED_BIN is not executable: %s\n' "$ZED_BIN" >&2
  exit 2
fi

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
export HOME="$ROOT/home"
export ZED_PKG_HOME="$ROOT/zed-pkg-home"
mkdir -p "$HOME" "$ZED_PKG_HOME" "$ROOT/no-git"

fail() {
  printf 'pack publication-boundary E2E failed: %s\n' "$*" >&2
  exit 1
}

init_fixture() {
  local name="$1"
  local policy="$2"
  local fixture="$ROOT/$name"
  mkdir -p "$fixture"

  cat >"$fixture/.zpkg.toml" <<EOF
[package]
org = "zed-e2e"
name = "$name"
version = "1.2.3"

[package.repository]
vcs = "git"
url = "https://example.invalid/zed-e2e/$name.git"
EOF

  printf 'secret.env\n' >"$fixture/.gitignore"
  printf 'safe payload for %s\n' "$name" >"$fixture/payload.txt"
  printf '# %s\n' "$name" >"$fixture/README.md"

  case "$policy" in
    reject)
      ;;
    zedignore)
      printf 'secret.env\n' >"$fixture/.zedignore"
      ;;
    publish-exclude)
      cat >>"$fixture/.zpkg.toml" <<'EOF'

[publish]
exclude = ["secret.env"]
EOF
      ;;
    *)
      fail "unknown fixture policy: $policy"
      ;;
  esac

  git -C "$fixture" init -q
  git -C "$fixture" add -- .
  git -C "$fixture" \
    -c user.name='Zed E2E' \
    -c user.email='zed-e2e@example.invalid' \
    commit -qm 'fixture baseline'

  # Create the ignored input only after the baseline commit so Git can prove it
  # is untracked. The value is synthetic and never a usable credential.
  printf 'TOKEN=fixture-only-do-not-publish\n' >"$fixture/secret.env"
  printf '%s\n' "$fixture"
}

run_pack() {
  local fixture="$1"
  local runtime="$2"
  local stdout="$3"
  local stderr="$4"

  if [[ "$runtime" == gitless ]]; then
    (cd "$fixture" && PATH="$ROOT/no-git" "$ZED_BIN" pack >"$stdout" 2>"$stderr")
  else
    (cd "$fixture" && "$ZED_BIN" pack >"$stdout" 2>"$stderr")
  fi
}

expect_rejected() {
  local name="$1"
  local runtime="$2"
  local fixture
  fixture="$(init_fixture "$name" reject)"
  local stdout="$fixture/pack.stdout"
  local stderr="$fixture/pack.stderr"

  if run_pack "$fixture" "$runtime" "$stdout" "$stderr"; then
    cat "$stdout" >&2 || true
    cat "$stderr" >&2 || true
    fail "$name unexpectedly packed an ignored secret"
  fi

  grep -Fq 'secret.env' "$stderr" || {
    cat "$stderr" >&2
    fail "$name rejection did not identify secret.env"
  }
  grep -Fq 'Git ignore rules are not publication rules' "$stderr" || {
    cat "$stderr" >&2
    fail "$name rejection did not explain the publication boundary"
  }
  if [[ "$runtime" == gitless ]]; then
    grep -Fq 'Git was unavailable' "$stderr" || {
      cat "$stderr" >&2
      fail "$name did not report the conservative Git-less fallback"
    }
  fi
}

expect_allowed_and_pruned() {
  local name="$1"
  local policy="$2"
  local runtime="$3"
  local fixture
  fixture="$(init_fixture "$name" "$policy")"
  local stdout="$fixture/pack.stdout"
  local stderr="$fixture/pack.stderr"

  if ! run_pack "$fixture" "$runtime" "$stdout" "$stderr"; then
    cat "$stdout" >&2 || true
    cat "$stderr" >&2 || true
    fail "$name should have packed after an explicit exclusion"
  fi

  local archive
  archive="$(find "$fixture/.zed/pack" -maxdepth 1 -type f -name '*.tar.gz' -print -quit)"
  [[ -n "$archive" ]] || fail "$name did not produce a tar.gz artifact"

  local listing="$fixture/archive.list"
  tar -tzf "$archive" >"$listing"
  grep -Fq 'pkg/payload.txt' "$listing" || {
    cat "$listing" >&2
    fail "$name artifact omitted the safe payload"
  }
  if grep -Fq 'secret.env' "$listing"; then
    cat "$listing" >&2
    fail "$name artifact contained secret.env"
  fi
}

expect_rejected 'ignored-secret-with-git' git
expect_rejected 'ignored-secret-without-git' gitless
expect_allowed_and_pruned 'zedignore-exclusion' zedignore git
expect_allowed_and_pruned 'manifest-exclusion' publish-exclude git
expect_allowed_and_pruned 'zedignore-exclusion-without-git' zedignore gitless

printf 'pack publication-boundary E2E passed\n'
