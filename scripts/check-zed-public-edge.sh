#!/usr/bin/env bash
set -euo pipefail

url="${1:-}"
enforce="${2:-false}"
evidence="${3:-/dev/stdout}"
if [[ "$url" != https://* ]]; then
  echo "usage: $0 <https-url> [enforce] [evidence-file]" >&2
  exit 64
fi

read -r host port < <(
  python3 - "$url" <<'PY'
import sys
from urllib.parse import urlparse
value = urlparse(sys.argv[1])
if value.scheme != 'https' or not value.hostname:
    raise SystemExit(64)
print(value.hostname, value.port or 443)
PY
)

mkdir -p "$(dirname "$evidence")"
temporary="$(mktemp -d)"
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT

dns='missing'
tls='skipped'
http='skipped'

if getent ahosts "$host" >"$temporary/dns.txt" 2>"$temporary/dns.err"; then
  dns='ready'
  if timeout 20s openssl s_client \
    -connect "$host:$port" \
    -servername "$host" \
    -verify_return_error \
    </dev/null >"$temporary/tls.txt" 2>&1; then
    tls='ready'
  else
    tls='failed'
  fi

  if curl --fail --silent --show-error \
    --connect-timeout 10 \
    --max-time 20 \
    --retry 2 \
    --retry-delay 2 \
    --retry-all-errors \
    -D "$temporary/headers.txt" \
    -o "$temporary/body.txt" \
    "$url"; then
    http='ready'
  else
    http='failed'
  fi
fi

overall='not-ready'
if [[ "$dns" == ready && "$tls" == ready && "$http" == ready ]]; then
  overall='ready'
fi

{
  echo "url=$url"
  echo "host=$host"
  echo "dns=$dns"
  echo "tls=$tls"
  echo "http=$http"
  echo "overall=$overall"
  if [[ -s "$temporary/headers.txt" ]]; then
    echo
    echo '[response-headers]'
    sed -n '1,20p' "$temporary/headers.txt"
  fi
  if [[ "$tls" == failed && -s "$temporary/tls.txt" ]]; then
    echo
    echo '[tls-tail]'
    tail -n 20 "$temporary/tls.txt"
  fi
} > "$evidence"

cat "$evidence"
case "$enforce" in
  1|true|TRUE|yes|YES)
    [[ "$overall" == ready ]]
    ;;
  0|false|FALSE|no|NO|'')
    ;;
  *)
    echo "invalid enforce value: $enforce" >&2
    exit 64
    ;;
esac
