#!/usr/bin/env bash
# Drive the ORES remote browser grid (dd-browser-test-server) against a
# cluster-reachable zed web UI, through ALL THREE back-ends (Playwright,
# Puppeteer, Selenium) via the POST /run scenario API. See docs/13 in zed-docs.
#
# /run is in-cluster only, so this execs the grid pod (which has Node + its own
# SERVER_AUTH_SECRET) and POSTs to http://localhost:8104/run from there.
#
#   cluster/remote-grid.sh <kube-context> <base-url> [namespace]
#
#   <base-url>  the zed web UI as the GRID sees it, e.g.
#               http://dd-zed-web-server.zed.svc.cluster.local:8081
#   namespace   where dd-browser-test-server runs (default: default)
set -uo pipefail

CTX="${1:?usage: remote-grid.sh <kube-context> <base-url> [namespace]}"
BASE="${2:?missing <base-url>}"
NS="${3:-default}"
K=(kubectl --context "$CTX" -n "$NS")
DEPLOY="deploy/dd-browser-test-server"
fails=0
pass(){ printf '\033[1;32m  PASS\033[0m %s\n' "$*"; }
bad(){ printf '\033[1;31m  FAIL\033[0m %s\n' "$*"; fails=$((fails+1)); }

# One scenario == a /run request body (JSON), plus a substring we expect to find
# in the response's `extracted` map. __BASE__ is replaced with the target URL.
# The node reader (fed on stdin) takes the body as argv[2] and prints a compact
# JSON verdict; SERVER_AUTH_SECRET comes from the pod's own env.
READER='const b=process.argv[2];fetch("http://localhost:8104/run",{method:"POST",headers:{"content-type":"application/json","x-server-auth":process.env.SERVER_AUTH_SECRET},body:b}).then(r=>r.json()).then(j=>console.log(JSON.stringify({ok:j.ok,title:j.finalTitle,extracted:j.extracted||{},errs:(j.pageErrors||[]).length}))).catch(e=>console.log(JSON.stringify({ok:false,error:e.message})))'

# scenario name | expected-extract-substring | steps-json (with __BASE__)
run_scenario() { # tool name expect steps
  local tool="$1" name="$2" expect="$3" steps="$4"
  local body; body="$(printf '{"tool":"%s","steps":%s}' "$tool" "${steps//__BASE__/$BASE}")"
  local out; out="$("${K[@]}" exec -i "$DEPLOY" -- node /dev/stdin "$body" <<<"$READER" 2>/dev/null)"
  if printf '%s' "$out" | grep -q '"ok":true' && printf '%s' "$out" | grep -qF "$expect"; then
    pass "$tool / $name"
  else
    bad "$tool / $name  ->  ${out:-<no response>}"
  fi
}

echo "grid=$CTX/$NS  target=$BASE"
for tool in playwright puppeteer selenium; do
  # 1. home page renders the brand + a package list
  run_scenario "$tool" "home renders" "zed" \
    '[{"action":"goto","url":"__BASE__/","waitUntil":"load"},{"action":"waitForSelector","selector":".pkg-list"},{"action":"extractText","selector":".brand","name":"brand"}]'
  # 2. search page renders its input box (HTMX live search UI)
  run_scenario "$tool" "search UI" "ok" \
    '[{"action":"goto","url":"__BASE__/search","waitUntil":"load"},{"action":"waitForSelector","selector":"#q"},{"action":"extractAttribute","selector":"#q","attribute":"id","name":"ok"}]'
done

echo
if [ "$fails" -eq 0 ]; then printf '\033[1;32mRemote grid drove the zed UI through all three back-ends.\033[0m\n'; else
  printf '\033[1;31m%d check(s) failed.\033[0m\n' "$fails"; exit 1; fi
