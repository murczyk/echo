#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

target_host=${1:-$DEFAULT_TARGET_HOST}
pool_key=
declare -a pool_args=()

validate_bundle
for pool_key in "${POOL_KEYS[@]}"; do
  load_pool "$pool_key"
  pool_args+=(
    "$pool_key"
    "$(pool_unit "$pool_key")"
    "$ROUTER_PORT"
    "$ROUTER_METRICS_PORT"
    "$ROUTER_EXPECTED_MODEL_ID"
  )
done
load_pool general

ssh -o BatchMode=yes "$target_host" bash -s -- \
  "$ROUTER_HOST" \
  "$VLLM_ROUTER_VERSION" \
  "$SIGNOZ_OTEL_COLLECTOR_BINARY_SHA256" \
  "${pool_args[@]}" <<'REMOTE'
set -euo pipefail

router_host=$1
router_version=$2
collector_sha256=$3
shift 3

die() {
  printf '[echo-vllm-router] ERROR: %s\n' "$*" >&2
  exit 1
}

wait_for_url() {
  local url=$1
  local attempt

  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then return; fi
    sleep 1
  done
  die "URL did not become healthy: $url"
}

check_listener() {
  local expected=$1
  local port=$2
  local listeners

  listeners=$(ss -H -ltn | awk -v suffix=":$port" '$4 ~ suffix "$" { print $4 }')
  [[ "$listeners" == "$expected" ]] \
    || die "unexpected listeners for port $port: ${listeners:-none}"
}

systemd-analyze verify \
  /etc/systemd/system/echo-vllm-router.service \
  /etc/systemd/system/echo-vllm-router@.service \
  /etc/systemd/system/echo-vllm-router-otel.service
systemctl is-enabled --quiet echo-vllm-router-otel.service \
  || die "echo-vllm-router-otel.service is not enabled"
systemctl is-active --quiet echo-vllm-router-otel.service \
  || die "echo-vllm-router-otel.service is not active"

installed_version=$(/opt/echo-vllm-router/current/bin/python -c 'import vllm_router; print(vllm_router.__version__)')
[[ "$installed_version" == "$router_version" ]] || die "router version mismatch"
installed_collector_sha256=$(sha256sum /opt/echo-vllm-router/bin/signoz-otel-collector | awk '{print $1}')
[[ "$installed_collector_sha256" == "$collector_sha256" ]] || die "collector checksum mismatch"

(( $# > 0 && $# % 5 == 0 )) || die "invalid pool verification arguments"
while (( $# > 0 )); do
  pool=$1
  unit=$2
  router_port=$3
  metrics_port=$4
  expected_model_id=$5
  shift 5

  router_url="http://$router_host:$router_port"
  metrics_url="http://127.0.0.1:$metrics_port/metrics"
  systemctl is-enabled --quiet "$unit" || die "$unit is not enabled"
  systemctl is-active --quiet "$unit" || die "$unit is not active"
  wait_for_url "$router_url/health"
  wait_for_url "$metrics_url"
  check_listener "$router_host:$router_port" "$router_port"
  check_listener "127.0.0.1:$metrics_port" "$metrics_port"
  curl -fsS --max-time 10 "$router_url/v1/models" \
    | python3 -c 'import json,sys; expected=sys.argv[1]; data=json.load(sys.stdin); assert {item["id"] for item in data["data"]} == {expected}' "$expected_model_id" \
    || die "router pool $pool does not expose only model $expected_model_id"
  curl -fsS --max-time 10 "$metrics_url" \
    | python3 -c 'import sys; data=sys.stdin.read(); assert any(line.startswith("vllm_router_") for line in data.splitlines())' \
    || die "router metrics are unavailable for $pool"
  printf 'Pool %s: %s:%s, metrics 127.0.0.1:%s, exact model verified\n' \
    "$pool" "$router_host" "$router_port" "$metrics_port"
done

if ss -H -ltn | awk '$4 ~ /:8888$/ { found=1 } END { exit !found }'; then
  die "collector internal metrics unexpectedly listen on port 8888"
fi

printf 'Router: v%s, all pool health/models/metrics verified\n' "$router_version"
printf 'Collector: checksum verified\n'
printf '[echo-vllm-router] Verification passed\n'
REMOTE
