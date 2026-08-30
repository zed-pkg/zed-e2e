#!/usr/bin/env bash
# Shared gate machinery for prove-100.sh.
#
# A gate is a named, independently-meaningful claim about zed-pkg that either
# holds or does not. Gates never print "ok" for work they skipped: a gate that
# cannot run records SKIP with the reason, and a run containing a SKIP is not a
# 100% run. That distinction is the whole point of this harness — the existing
# suites are green partly because they route around the claims that are hardest
# to keep true (real VCS provenance, the forge mirror, the live edge).

set -uo pipefail

PROOF_ROOT="${PROOF_ROOT:-}"
PROOF_RECEIPTS="${PROOF_RECEIPTS:-}"
PROOF_START_EPOCH="${PROOF_START_EPOCH:-$(date -u +%s)}"

declare -a GATE_IDS=()
declare -A GATE_STATUS=()
declare -A GATE_TITLE=()
declare -A GATE_DETAIL=()
declare -A GATE_SECONDS=()

c_reset=$'\033[0m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_dim=$'\033[2m'
if [[ ! -t 1 || -n "${NO_COLOR:-}" ]]; then c_reset=; c_red=; c_grn=; c_yel=; c_dim=; fi

log()  { printf '%s\n' "$*" >&2; }
note() { printf '%s%s%s\n' "$c_dim" "$*" "$c_reset" >&2; }

# json_escape <string> — minimal, dependency-free JSON string escaping.
json_escape() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

gate_register() { GATE_IDS+=("$1"); GATE_TITLE["$1"]="$2"; GATE_STATUS["$1"]=PENDING; GATE_DETAIL["$1"]=""; }

gate_record() {
  local id=$1 status=$2 detail=${3:-} secs=${4:-0}
  GATE_STATUS["$id"]=$status
  GATE_DETAIL["$id"]=$detail
  GATE_SECONDS["$id"]=$secs
  if [[ -n "$PROOF_RECEIPTS" ]]; then
    mkdir -p "$PROOF_RECEIPTS"
    printf '{"gate":"%s","title":"%s","status":"%s","seconds":%s,"detail":"%s"}\n' \
      "$(json_escape "$id")" "$(json_escape "${GATE_TITLE[$id]:-}")" \
      "$(json_escape "$status")" "${secs:-0}" "$(json_escape "$detail")" \
      > "$PROOF_RECEIPTS/$id.json"
  fi
  case $status in
    PASS) printf '%s  PASS%s  %s — %s\n' "$c_grn" "$c_reset" "$id" "${GATE_TITLE[$id]}" >&2 ;;
    FAIL) printf '%s  FAIL%s  %s — %s\n        %s\n' "$c_red" "$c_reset" "$id" "${GATE_TITLE[$id]}" "$detail" >&2 ;;
    SKIP) printf '%s  SKIP%s  %s — %s\n        %s\n' "$c_yel" "$c_reset" "$id" "${GATE_TITLE[$id]}" "$detail" >&2 ;;
  esac
}

# run_gate <id> <fn> — runs the gate body, times it, and turns a nonzero exit
# into FAIL carrying the body's last message (set via gate_fail/gate_skip).
GATE_MSG=""
gate_fail() { GATE_MSG=$1; return 1; }
gate_skip() { GATE_MSG=$1; return 77; }

run_gate() {
  local id=$1 fn=$2 t0 t1 rc
  if [[ -n "${PROOF_ONLY:-}" ]] && [[ ",$PROOF_ONLY," != *",$id,"* ]]; then
    gate_record "$id" SKIP "not selected by --only" 0; return 0
  fi
  printf '\n%s▶ %s — %s%s\n' "$c_dim" "$id" "${GATE_TITLE[$id]}" "$c_reset" >&2
  GATE_MSG=""
  t0=$(date -u +%s)
  "$fn"; rc=$?
  t1=$(date -u +%s)
  case $rc in
    0)  gate_record "$id" PASS "${GATE_MSG:-}" $((t1-t0)) ;;
    77) gate_record "$id" SKIP "${GATE_MSG:-skipped}" $((t1-t0)) ;;
    *)  gate_record "$id" FAIL "${GATE_MSG:-exited $rc}" $((t1-t0)) ;;
  esac
  return 0
}

# require_cmd <cmd> [hint] — gate_skip when a tool the gate needs is absent, so
# a machine missing docker reports SKIP rather than a misleading FAIL.
require_cmd() {
  command -v "$1" >/dev/null 2>&1 && return 0
  gate_skip "${2:-required command '$1' is not on PATH}"
}

# sha256_of <file> — sha256sum or shasum, whichever this OS has.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

proof_summary() {
  local pass=0 fail=0 skip=0 id
  printf '\n%s\n' "──────────────────────────────────────────────────────────────" >&2
  for id in "${GATE_IDS[@]}"; do
    case ${GATE_STATUS[$id]} in PASS) ((pass++));; FAIL) ((fail++));; SKIP) ((skip++));; esac
  done
  printf 'zed-pkg proof: %d passed, %d failed, %d skipped, of %d gates\n' \
    "$pass" "$fail" "$skip" "${#GATE_IDS[@]}" >&2

  if [[ -n "$PROOF_RECEIPTS" ]]; then
    local out="$PROOF_RECEIPTS/../proof-report.json" first=1
    { printf '{"generated_at":"%s","gates":[' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      for id in "${GATE_IDS[@]}"; do
        [[ $first -eq 1 ]] || printf ','
        first=0
        printf '{"gate":"%s","title":"%s","status":"%s","seconds":%s,"detail":"%s"}' \
          "$(json_escape "$id")" "$(json_escape "${GATE_TITLE[$id]}")" \
          "$(json_escape "${GATE_STATUS[$id]}")" "${GATE_SECONDS[$id]:-0}" \
          "$(json_escape "${GATE_DETAIL[$id]:-}")"
      done
      printf '],"passed":%d,"failed":%d,"skipped":%d,"complete":%s}\n' \
        "$pass" "$fail" "$skip" "$([[ $fail -eq 0 && $skip -eq 0 ]] && echo true || echo false)"
    } > "$out"
    note "report: $out"
  fi

  if [[ $fail -gt 0 ]]; then
    printf '%sNOT PROVEN — %d gate(s) failed.%s\n' "$c_red" "$fail" "$c_reset" >&2
    return 1
  fi
  if [[ $skip -gt 0 ]]; then
    printf '%sNOT PROVEN — %d gate(s) could not run. A skipped gate is an unproven claim.%s\n' \
      "$c_yel" "$skip" "$c_reset" >&2
    return 2
  fi
  printf '%sPROVEN — every gate ran and passed.%s\n' "$c_grn" "$c_reset" >&2
  return 0
}
