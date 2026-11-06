#!/usr/bin/env bash
# Real-Zed source packaging boundary for AttoLang.
# SOURCE/ARTIFACT proof only: no compiler is invoked; never count as guest parity.
set -euo pipefail

: "${ZED_BIN:?set ZED_BIN to an executable built from a pinned zed-cli commit}"
[[ -x "$ZED_BIN" ]] || {
  printf 'ZED_BIN is not executable: %s\n' "$ZED_BIN" >&2
  exit 2
}
for command in git tar sha256sum cmp; do
  command -v "$command" >/dev/null || {
    printf 'required tool is missing: %s\n' "$command" >&2
    exit 2
  }
done

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
export HOME="$ROOT/home"
export ZED_PKG_HOME="$ROOT/zed-pkg-home"
mkdir -p "$HOME" "$ZED_PKG_HOME" "$ROOT/package/src" "$ROOT/logs"
PACKAGE="$ROOT/package"

fail() {
  printf 'AttoLang source package boundary failed: %s\n' "$*" >&2
  exit 1
}

# This is deliberately "universal" until zed-interfaces#182 lands:
# old CLIs MUST NOT silently reinterpret the proposed "attolang" token.
cat >"$PACKAGE/.zpkg.toml" <<'TOML'
[package]
org = "zed-e2e"
name = "attolang-source-bridge"
version = "0.1.0"
description = "Source-only packaging fixture, never compiler-certified"
license = "MIT"
language = "universal"

[package.repository]
vcs = "git"
url = "https://example.invalid/zed-e2e/attolang-source-bridge.git"

[install]
adapter = "none"
dir = ".vendor/.zed"

[publish]
include_readme = true
TOML

# Existing compiler-owned project marker shape, not a second Zed manifest.
cat >"$PACKAGE/.ores.pkg.toml" <<'TOML'
schema_version = "1"

[project]
name = "attolang-source-bridge"
version = "0.1.0"
root = "."

[source]
roots = ["src"]
import_paths = []
TOML

# Intentionally not a guest program. Only tests preservation of .atto bytes.
cat >"$PACKAGE/src/source.atto" <<'ATTO'
// AttoLang source-packaging fixture.
// A parser or compiler MUST NOT infer conformance from this file.
// Zed must retain these bytes exactly, including the final newline.
ATTO
printf 'private.env\n' >"$PACKAGE/.gitignore"
printf '# AttoLang source packaging fixture (not executable conformance)\n' >"$PACKAGE/README.md"

git -C "$PACKAGE" init -q
git -C "$PACKAGE" add -- .
git -C "$PACKAGE" -c user.name='Zed E2E' \
  -c user.email='zed-e2e@example.invalid' commit -qm 'source fixture'

# A *real* CLI validates the currently supported manifest without contacting
# any registry; a bare JSON parser is not a substitute for Zed validation.
if ! (cd "$PACKAGE" && "$ZED_BIN" validate --manifest .zpkg.toml --json \
    >"$ROOT/logs/validate.json" 2>"$ROOT/logs/validate.err"); then
  cat "$ROOT/logs/validate.err" >&2
  fail 'real zed validate rejected the compatibility manifest'
fi

pack() {
  (cd "$PACKAGE" && "$ZED_BIN" pack >"$ROOT/logs/pack.out" 2>"$ROOT/logs/pack.err") || {
    cat "$ROOT/logs/pack.err" >&2
    fail 'zed pack failed'
  }
}

archive_path() {
  find "$PACKAGE/.zed/pack" -maxdepth 1 -name '*.tar.gz' -type f -print -quit
}

check_archive() {
  local archive="$1"
  [[ -n "$archive" && -f "$archive" ]] || fail 'pack produced no tar.gz archive'

  local listing="$ROOT/logs/archive.list"
  tar -tzf "$archive" >"$listing"
  for path in pkg/.zpkg.toml pkg/.ores.pkg.toml pkg/src/source.atto; do
    grep -Fxq "$path" "$listing" || {
      cat "$listing" >&2
      fail "required AttoLang package entry missing: $path"
    }
    tar -xzOf "$archive" "$path" >"$ROOT/logs/$(basename "$path").actual"
    cmp "$PACKAGE/${path#pkg/}" "$ROOT/logs/$(basename "$path").actual" || \
      fail "source/manifest bytes changed: $path"
  done
  if grep -Eq '(^|/)(private\.env|\.git/)' "$listing"; then
    fail 'the packed source contains a secret or Git metadata'
  fi
}

pack
ARCHIVE="$(archive_path)"
check_archive "$ARCHIVE"
FIRST_DIGEST="$(sha256sum "$ARCHIVE" | cut -d ' ' -f1)"
pack
ARCHIVE="$(archive_path)"
check_archive "$ARCHIVE"
SECOND_DIGEST="$(sha256sum "$ARCHIVE" | cut -d ' ' -f1)"
[[ "$FIRST_DIGEST" == "$SECOND_DIGEST" ]] || \
  fail 'unchanged AttoLang source did not produce deterministic packed bytes'

# A Git-ignored secret is not automatically safe to publish: require the same
# reviewable publication boundary for AttoLang as every other Zed package.
printf 'TOKEN=synthetic-do-not-publish\n' >"$PACKAGE/private.env"
if (cd "$PACKAGE" && "$ZED_BIN" pack >"$ROOT/logs/rejected.out" \
    2>"$ROOT/logs/rejected.err"); then
  fail 'ignored private.env unexpectedly packed'
fi
grep -Fq 'private.env' "$ROOT/logs/rejected.err" || {
  cat "$ROOT/logs/rejected.err" >&2
  fail 'secret rejection did not identify the unsafe file'
}

# Explicit, reviewed exclusion unblocks publication; the artifact still may
# not contain the secret. The .zedignore is tracked and clean before pack.
printf 'private.env\n' >"$PACKAGE/.zedignore"
git -C "$PACKAGE" add .zedignore
git -C "$PACKAGE" -c user.name='Zed E2E' \
  -c user.email='zed-e2e@example.invalid' commit -qm 'review secret exclusion'
pack
ARCHIVE="$(archive_path)"
check_archive "$ARCHIVE"

printf '%s\n' 'PASS: real Zed validation, deterministic .atto/.ores.pkg.toml packing and secret refusal'
printf '%s\n' 'PROOF CLASSIFICATION: SOURCE_ARTIFACT_ONLY (no AttoLang compiler or guest runtime executed)'
