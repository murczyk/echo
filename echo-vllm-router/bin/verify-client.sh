#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

client_host=${1:-$DEFAULT_CLIENT_HOST}
pool_selector=${POOL:-all}
pool_key=
declare -a pool_args=()

validate_bundle
validate_pool_selector "$pool_selector"
while IFS= read -r pool_key; do
  load_pool "$pool_key"
  pool_args+=("$ROUTER_POOL" "$ROUTER_PORT" "$ROUTER_EXPECTED_MODEL_ID")
done < <(selected_pool_keys "$pool_selector")
load_pool general

ssh -o BatchMode=yes "$client_host" bash -s -- \
  "$ROUTER_HOST" \
  "${pool_args[@]}" <<'REMOTE'
set -euo pipefail

router_host=$1
shift

(( $# > 0 && $# % 3 == 0 )) || {
  printf '[echo-vllm-router] ERROR: invalid pool client-verification arguments\n' >&2
  exit 1
}
while (( $# > 0 )); do
  pool=$1
  router_port=$2
  expected_model_id=$3
  router_url="http://$router_host:$router_port"
  shift 3

  curl -fsS --max-time 10 "$router_url/health" >/dev/null
  curl -fsS --max-time 10 "$router_url/v1/models" \
    | python3 -c 'import json,sys; expected=sys.argv[1]; data=json.load(sys.stdin); assert {item["id"] for item in data["data"]} == {expected}' "$expected_model_id"
  printf 'Pool %s: health and exact model reachable\n' "$pool"
done
printf '[echo-vllm-router] Client %s reached selected router pools\n' "$(hostname)"
REMOTE
