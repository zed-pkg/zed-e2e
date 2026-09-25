#!/usr/bin/env bash
set -euo pipefail

harness="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sup="$harness/workspace/supervisor"
mkdir -p /tmp/bmscl-e2e-artifacts

shopt -s nullglob
ebins=("$sup"/_build/default/lib/*/ebin)
if [[ ${#ebins[@]} -eq 0 ]]; then
  echo 'no compiled BEAM ebin directories found' >&2
  exit 1
fi

exec erl -noshell -pa "${ebins[@]}" -eval '
  application:ensure_all_started(crypto),
  application:load(bmscl_supervisor),
  application:set_env(bmscl_supervisor, durable_store_module, bmscl_e2e_durable_store),
  application:set_env(bmscl_supervisor, guest_control_port, 9101),
  application:set_env(bmscl_supervisor, guest_artifact_root, "/tmp/bmscl-e2e-artifacts"),
  application:set_env(bmscl_supervisor, critical_section_max_lease_ms, 300000),
  {ok, _Registry} = bmscl_critical_section_registry:start_link(),
  {ok, _Control} = bmscl_guest_control:start_link(),
  io:format("bmscl e2e guest control ready~n", []),
  receive stop -> ok end.
'
