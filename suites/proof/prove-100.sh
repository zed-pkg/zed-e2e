#!/usr/bin/env bash
# prove-100.sh — the end-to-end proof that zed-pkg does dependency management,
# backed by GitHub, over the public edge.
#
#   bash suites/proof/prove-100.sh                 # hermetic gates
#   bash suites/proof/prove-100.sh --live          # live edge gates only
#   bash suites/proof/prove-100.sh --all           # both
#   bash suites/proof/prove-100.sh --only G3,G7    # one or two gates
#   bash suites/proof/prove-100.sh --keep          # leave the stack up
#
# Exit codes: 0 proven, 1 a gate failed, 2 a gate could not run. Two is not a
# pass. A claim nobody exercised is not a claim anybody should rely on.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export E2E_ROOT=$(cd "$HERE/../.." && pwd)

MODE=hermetic
KEEP=0
export PROOF_ONLY=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --live) MODE=live ;;
    --all)  MODE=all ;;
    --keep) KEEP=1 ;;
    --only) PROOF_ONLY=$2; shift ;;
    --only=*) PROOF_ONLY=${1#--only=} ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 64 ;;
  esac
  shift
done

export PROOF_ROOT="${PROOF_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/zed-proof-XXXXXX")}"
export PROOF_RECEIPTS="$PROOF_ROOT/receipts"
mkdir -p "$PROOF_RECEIPTS"

# shellcheck source=lib.sh
source "$HERE/lib.sh"

printf 'zed-pkg proof — mode=%s root=%s\n' "$MODE" "$PROOF_ROOT" >&2

cleanup() {
  if [[ $KEEP -eq 0 && -f "$PROOF_ROOT/api_url" ]]; then
    ( cd "$E2E_ROOT" && npm run stack:down ) >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ $MODE == hermetic || $MODE == all ]]; then
  # shellcheck source=gates-hermetic.sh
  source "$HERE/gates-hermetic.sh"
  run_gate G0 g0
  run_gate G1 g1
  run_gate G2 g2
  run_gate G3 g3
  run_gate G4 g4
  run_gate G5 g5
  run_gate G6 g6
  run_gate G7 g7
  run_gate G8 g8
  run_gate G9 g9
  run_gate G10 g10
fi

if [[ $MODE == live || $MODE == all ]]; then
  # shellcheck source=gates-live.sh
  source "$HERE/gates-live.sh"
  run_gate L1 l1
  run_gate L2 l2
  run_gate L3 l3
  run_gate L4 l4
  run_gate L5 l5
fi

proof_summary
exit $?
