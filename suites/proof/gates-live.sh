#!/usr/bin/env bash
# Live gates: the public edge, as an end user meets it. These need real network
# and prove nothing about code — they prove the deployment.
#
# The existing public-edge-readiness.yml probes registry.aws.zpkg.tech and
# hetzner.zpkg.tech. The CLI's compiled-in default registry is
# https://registry.zpkg.net (zed-interfaces/src/rust/registry.rs), and the CDN
# default is https://cdn.zpkg.net (zed-cli/src/mirror.rs). These gates probe
# the hostnames the shipped binary actually uses, which is the only set whose
# health a user can feel.

LIVE_REGISTRY="${LIVE_REGISTRY:-https://registry.zpkg.net}"
LIVE_CDN="${LIVE_CDN:-https://cdn.zpkg.net}"
LIVE_SITE="${LIVE_SITE:-https://zpkg.net}"

probe() { curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$1" 2>/dev/null; }

gate_register L1 "Public hostnames resolve and terminate TLS"
l1() {
  require_cmd curl || return 77
  local bad=()
  for host in "${LIVE_SITE#https://}" "${LIVE_REGISTRY#https://}" "${LIVE_CDN#https://}"; do
    getent hosts "$host" >/dev/null 2>&1 || host "$host" >/dev/null 2>&1 || bad+=("$host: no DNS")
  done
  [[ ${#bad[@]} -eq 0 ]] || gate_fail "${bad[*]}"
  GATE_MSG="all three hostnames resolve"
}

gate_register L2 "Marketing site, registry health, and CDN all answer"
l2() {
  local site reg cdn fails=()
  site=$(probe "$LIVE_SITE/")
  reg=$(probe "$LIVE_REGISTRY/healthz")
  cdn=$(probe "$LIVE_CDN/.well-known/zpkg-mirrors.json")
  [[ "$site" == 2* ]] || fails+=("$LIVE_SITE/ -> $site")
  [[ "$reg"  == 2* ]] || fails+=("$LIVE_REGISTRY/healthz -> $reg")
  [[ "$cdn"  == 2* ]] || fails+=("$LIVE_CDN/.well-known/zpkg-mirrors.json -> $cdn")
  [[ ${#fails[@]} -eq 0 ]] || gate_fail "${fails[*]}"
  GATE_MSG="site $site, registry $reg, cdn $cdn"
}

gate_register L3 "The live CDN serves the mirror set the CLI expects"
l3() {
  local doc
  doc=$(curl -fsS --max-time 20 "$LIVE_CDN/.well-known/zpkg-mirrors.json") \
    || gate_fail "$LIVE_CDN/.well-known/zpkg-mirrors.json did not answer"
  grep -q '"object-store"' <<<"$doc" || gate_fail "mirror set declares no object-store entry"
  grep -q "$LIVE_REGISTRY" <<<"$doc" || gate_fail "mirror set does not point back at $LIVE_REGISTRY"
  # The alternate hostname is the point of the CDN: it must not live in the
  # zone it is backing up.
  grep -q 'workers.dev' <<<"$doc" \
    || gate_fail "mirror set has no off-zone alternate URL; a zone outage takes the fallback with it"
  GATE_MSG="mirror set is well-formed and carries an off-zone alternate"
}

gate_register L4 "A published artifact downloads from the CDN and hashes to its pin"
l4() {
  [[ -n "${LIVE_PROOF_SHA256:-}" ]] \
    || gate_skip "set LIVE_PROOF_SHA256 to a published artifact digest to prove the read path"
  local out="$PROOF_ROOT/live-artifact"
  curl -fsSL --max-time 60 "$LIVE_CDN/artifacts/$LIVE_PROOF_SHA256.tar.gz" -o "$out" \
    || gate_fail "CDN would not serve artifacts/$LIVE_PROOF_SHA256.tar.gz"
  local got; got=$(sha256_of "$out")
  [[ "$got" == "$LIVE_PROOF_SHA256" ]] || gate_fail "CDN bytes hash to $got, expected $LIVE_PROOF_SHA256"
  GATE_MSG="CDN served $LIVE_PROOF_SHA256 and the bytes verify"
}

gate_register L5 "The CDN refuses writes and listing"
l5() {
  local put del list
  put=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X PUT --data x "$LIVE_CDN/artifacts/proof.txt")
  del=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X DELETE "$LIVE_CDN/artifacts/proof.txt")
  list=$(probe "$LIVE_CDN/artifacts/")
  [[ "$put" != 2* ]] || gate_fail "CDN accepted a PUT ($put) — the bucket is writable through the edge"
  [[ "$del" != 2* ]] || gate_fail "CDN accepted a DELETE ($del)"
  [[ "$list" != 2* ]] || gate_fail "CDN served a listing ($list) — the key space is enumerable"
  GATE_MSG="PUT $put, DELETE $del, listing $list — all refused"
}
