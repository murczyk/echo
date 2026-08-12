#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

client_host=${1:-$DEFAULT_CLIENT_HOST}

validate_bundle
ssh -o BatchMode=yes "$client_host" bash -s -- \
  "$ROUTER_HOST" \
  "$ROUTER_PORT" \
  "$EXPECTED_MODEL_ID" <<'REMOTE'
set -euo pipefail

router_host=$1
router_port=$2
expected_model_id=$3
router_url="http://$router_host:$router_port"

curl -fsS --max-time 10 "$router_url/health" >/dev/null
curl -fsS --max-time 10 "$router_url/v1/models" \
  | python3 -c 'import json,sys; expected=sys.argv[1]; data=json.load(sys.stdin); assert expected in {item["id"] for item in data["data"]}' "$expected_model_id"
printf '[echo-vllm-router] Client %s reached health and models endpoints\n' "$(hostname)"
REMOTE
