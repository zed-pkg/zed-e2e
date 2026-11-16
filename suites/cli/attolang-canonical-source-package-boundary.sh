#!/usr/bin/env bash
# Real Zed artifact admission for canonical AttoLang and legacy marker names.
# SOURCE_ARTIFACT_ONLY: never count this as real AttoLang compilation/execution.
set -euo pipefail

: "${ZED_BIN:?set ZED_BIN to a verified real Zed CLI executable}"
[[ -x "$ZED_BIN" ]] || { echo "ZED_BIN must be executable" >&2; exit 2; }
for command in git tar sha256sum cmp find grep cut; do
  command -v "$command" >/dev/null || { echo "missing $command" >&2; exit 2; }
done

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
export HOME="$ROOT/home"
export ZED_PKG_HOME="$ROOT/zed-home"
mkdir -p "$HOME" "$ZED_PKG_HOME"

fail() { echo "AttoLang marker source-artifact test failed: $*" >&2; exit 1; }

archive_path() {
  local project="$1"
  local found=()
  mapfile -d '' -t found < <(find "$project/.zed/pack" -maxdepth 1 -type f -name '*.tar.gz' -print0)
  [[ "${#found[@]}" -eq 1 ]] || fail "expected one archive, got ${#found[@]} in $project"
  printf '%s\n' "${found[0]}"
}

pack() {
  local project="$1"
  (cd "$project" && "$ZED_BIN" pack >"$ROOT/pack.stdout" 2>"$ROOT/pack.stderr") || {
    cat "$ROOT/pack.stderr" >&2
    fail "real zed pack failed for $(basename "$project")"
  }
}

check_archive() {
  local project="$1" marker="$2" archive="$3"
  local listing="$ROOT/listing"
  tar -tzf "$archive" >"$listing"
  for path in "pkg/.zpkg.toml" "pkg/$marker" "pkg/src/answer.atto"; do
    grep -Fxq "$path" "$listing" || fail "missing $path from $archive"
    tar -xzOf "$archive" "$path" >"$ROOT/verified-byte-copy"
    cmp "$project/${path#pkg/}" "$ROOT/verified-byte-copy" || fail "altered bytes in $path"
  done
  if [[ "$marker" == ".atto.pkg.toml" ]]; then
    ! grep -Fxq "pkg/.ores.pkg.toml" "$listing" || fail "canonical artifact accidentally carries legacy marker"
  else
    ! grep -Fxq "pkg/.atto.pkg.toml" "$listing" || fail "legacy artifact accidentally carries canonical marker"
  fi
  ! grep -Eq '(^|/)(\.git|private\.env)(/|$)' "$listing" || fail "artifact contains forbidden metadata"
}

make_project() {
  local project="$1" name="$2" marker="$3"
  mkdir -p "$project/src"
  cat >"$project/.zpkg.toml" <<TOML
[package]
org = "zed-e2e"
name = "$name"
version = "0.1.0"
description = "AttoLang native marker source-artifact-only fixture"
license = "MIT"
language = "universal"

[package.repository]
vcs = "git"
url = "https://example.invalid/zed-e2e/$name.git"

[install]
adapter = "none"
dir = ".vendor/.zed"

[publish]
include_readme = true
TOML
  cat >"$project/$marker" <<'TOML'
schema_version = "1"

[project]
name = "marker-compatibility"
version = "0.1.0"
root = "."

[source]
roots = ["src"]
import_paths = []
TOML
  cat >"$project/src/answer.atto" <<'ATTO'
// Source identity fixture; no compiler is executed by this suite.
pub fnc answer(): int { return 42; }
ATTO
  printf '# source artifact fixture\n' >"$project/README.md"
  git -C "$project" init -q
  git -C "$project" add -- .
  git -C "$project" -c user.name='Zed E2E' -c user.email='zed-e2e@example.invalid' commit -qm "source fixture"
}

for mode in canonical legacy; do
  if [[ "$mode" == canonical ]]; then
    marker=".atto.pkg.toml"
    name="attolang-canonical-marker"
  else
    marker=".ores.pkg.toml"
    name="attolang-legacy-marker"
  fi
  project="$ROOT/$mode"
  make_project "$project" "$name" "$marker"
  (cd "$project" && "$ZED_BIN" validate --manifest .zpkg.toml --json >"$ROOT/validate-$mode.json") ||
    fail "real zed validate failed for $mode"

  pack "$project"
  archive="$(archive_path "$project")"
  check_archive "$project" "$marker" "$archive"
  first_sha="$(sha256sum "$archive" | cut -d ' ' -f1)"
  pack "$project"
  archive="$(archive_path "$project")"
  check_archive "$project" "$marker" "$archive"
  second_sha="$(sha256sum "$archive" | cut -d ' ' -f1)"
  [[ "$first_sha" == "$second_sha" ]] || fail "$mode marker packaging is nondeterministic"

  printf '// $mode edited source revision\n' >>"$project/src/answer.atto"
  git -C "$project" add src/answer.atto
  git -C "$project" -c user.name='Zed E2E' -c user.email='zed-e2e@example.invalid' commit -qm 'edited source'
  pack "$project"
  archive="$(archive_path "$project")"
  check_archive "$project" "$marker" "$archive"
  final_sha="$(sha256sum "$archive" | cut -d ' ' -f1)"
  [[ "$first_sha" != "$final_sha" ]] || fail "$mode source edit returned stale archive"
done

echo "PASS: real Zed validates and packs canonical and legacy AttoLang source markers byte-for-byte"
echo "EVIDENCE: SOURCE_ARTIFACT_ONLY; no registry installation, compiler or guest execution"
