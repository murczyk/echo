#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
VERSIONS_FILE="$BUNDLE_DIR/versions.env"
REQUIREMENTS_FILE="$BUNDLE_DIR/requirements.lock"
OTEL_ENV_FILE="$BUNDLE_DIR/config/otel.env"

EXPECTED_HOSTNAME=ct-echo-vllm-router
POOL_KEYS=(general ocr-gemma nuextract)
# shellcheck disable=SC2034  # Used by scripts that source this library.
DEFAULT_TARGET_HOST=echo-vllm-router
# shellcheck disable=SC2034  # Used by scripts that source this library.
DEFAULT_CLIENT_HOST=echo-cbr

log() {
  printf '[echo-vllm-router] %s\n' "$*"
}

die() {
  printf '[echo-vllm-router] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

require_file() {
  [[ -f "$1" ]] || die "missing file: $1"
}

require_sha256() {
  [[ "$2" =~ ^[0-9a-f]{64}$ ]] || die "invalid SHA-256 for $1"
}

pool_env_file() {
  case "$1" in
    general) printf '%s/config/router.env\n' "$BUNDLE_DIR" ;;
    ocr-gemma | nuextract) printf '%s/config/router-%s.env\n' "$BUNDLE_DIR" "$1" ;;
    *) die "unknown router pool: $1" ;;
  esac
}

pool_unit() {
  case "$1" in
    general) printf 'echo-vllm-router.service\n' ;;
    ocr-gemma | nuextract) printf 'echo-vllm-router@%s.service\n' "$1" ;;
    *) die "unknown router pool: $1" ;;
  esac
}

validate_pool_selector() {
  local selector=${1:-all}

  case "$selector" in
    all | general | ocr-gemma | nuextract) ;;
    *) die "unknown router pool selector: $selector" ;;
  esac
}

selected_pool_keys() {
  local selector=${1:-all}

  validate_pool_selector "$selector"
  if [[ "$selector" == all ]]; then
    printf '%s\n' "${POOL_KEYS[@]}"
  else
    printf '%s\n' "$selector"
  fi
}

load_pool() {
  local pool_key=$1
  local env_file

  env_file=$(pool_env_file "$pool_key")
  require_file "$env_file"
  unset ROUTER_POOL ROUTER_HOST ROUTER_PORT ROUTER_EXPECTED_MODEL_ID
  unset ROUTER_WORKER_URLS ROUTER_POLICY ROUTER_METRICS_HOST ROUTER_METRICS_PORT
  # shellcheck disable=SC1090
  source "$env_file"
}

load_bundle() {
  require_file "$VERSIONS_FILE"
  require_file "$REQUIREMENTS_FILE"
  require_file "$OTEL_ENV_FILE"
  # shellcheck disable=SC1090
  source "$VERSIONS_FILE"
  # shellcheck disable=SC1090
  source "$OTEL_ENV_FILE"
  load_pool general

  require_sha256 VLLM_ROUTER_WHEEL_SHA256 "$VLLM_ROUTER_WHEEL_SHA256"
  require_sha256 VLLM_ROUTER_REQUIREMENTS_SHA256 "$VLLM_ROUTER_REQUIREMENTS_SHA256"
  require_sha256 SIGNOZ_OTEL_COLLECTOR_ARCHIVE_SHA256 "$SIGNOZ_OTEL_COLLECTOR_ARCHIVE_SHA256"
  require_sha256 SIGNOZ_OTEL_COLLECTOR_BINARY_SHA256 "$SIGNOZ_OTEL_COLLECTOR_BINARY_SHA256"
}

validate_current_pool() {
  local pool_key=$1
  local expected_pool
  local expected_port
  local expected_metrics_port
  local expected_model_id
  local expected_policy
  local otel_router_target
  local otel_worker_target
  local required_worker_url
  local worker_url
  local required_worker_found=0
  local -a worker_urls

  case "$pool_key" in
    general)
      expected_pool=general-gemma
      expected_port=8000
      expected_metrics_port=29000
      expected_model_id=google/gemma-4-26B-A4B-it
      expected_policy=cache_aware
      required_worker_url=http://100.92.119.117:8000
      otel_router_target=${OTEL_ROUTER_METRICS_TARGET_GENERAL:-}
      otel_worker_target=${OTEL_WORKER_METRICS_TARGET_GENERAL:-}
      ;;
    ocr-gemma)
      expected_pool=ocr-gemma
      expected_port=8001
      expected_metrics_port=29001
      expected_model_id=echo/ocr-gemma-4-26B-A4B-it
      expected_policy=round_robin
      required_worker_url=http://100.95.57.33:8000
      otel_router_target=${OTEL_ROUTER_METRICS_TARGET_OCR_GEMMA:-}
      otel_worker_target=${OTEL_WORKER_METRICS_TARGET_OCR_GEMMA:-}
      ;;
    nuextract)
      expected_pool=nuextract
      expected_port=8002
      expected_metrics_port=29002
      expected_model_id=numind/NuExtract3
      expected_policy=round_robin
      required_worker_url=http://100.113.47.83:8000
      otel_router_target=${OTEL_ROUTER_METRICS_TARGET_NUEXTRACT:-}
      otel_worker_target=${OTEL_WORKER_METRICS_TARGET_NUEXTRACT:-}
      ;;
    *) die "unknown router pool: $pool_key" ;;
  esac

  [[ "$ROUTER_POOL" == "$expected_pool" ]] || die "unexpected pool name for $pool_key"
  [[ "$ROUTER_HOST" == 100.105.172.96 ]] || die "unexpected router IP for $pool_key"
  [[ "$ROUTER_PORT" == "$expected_port" ]] || die "unexpected router port for $pool_key"
  [[ "$ROUTER_EXPECTED_MODEL_ID" == "$expected_model_id" ]] \
    || die "unexpected model ID for $pool_key"
  [[ "$ROUTER_POLICY" == "$expected_policy" ]] || die "unexpected routing policy for $pool_key"
  [[ "$ROUTER_METRICS_HOST" == 127.0.0.1 ]] || die "router metrics must use loopback for $pool_key"
  [[ "$ROUTER_METRICS_PORT" == "$expected_metrics_port" ]] \
    || die "unexpected router metrics port for $pool_key"
  [[ "$otel_router_target" == "$ROUTER_METRICS_HOST:$ROUTER_METRICS_PORT" ]] \
    || die "unexpected OTel router target for $pool_key"
  [[ "http://$otel_worker_target" == "$required_worker_url" ]] \
    || die "unexpected OTel worker target for $pool_key"

  read -r -a worker_urls <<<"$ROUTER_WORKER_URLS"
  ((${#worker_urls[@]} > 0)) || die "no router workers are configured for $pool_key"
  for worker_url in "${worker_urls[@]}"; do
    [[ "$worker_url" =~ ^https?://[^/[:space:]]+:[0-9]+$ ]] \
      || die "invalid worker URL in $pool_key: $worker_url"
    if [[ "$worker_url" == "$required_worker_url" ]]; then required_worker_found=1; fi
  done
  [[ $required_worker_found -eq 1 ]] || die "required worker is missing from $pool_key"
}

validate_pool_uniqueness() {
  local pool_key
  local worker_url
  local -a worker_urls
  local -A metrics_ports=()
  local -A router_ports=()
  local -A worker_pools=()

  for pool_key in "${POOL_KEYS[@]}"; do
    load_pool "$pool_key"
    [[ -z ${router_ports[$ROUTER_PORT]+set} ]] \
      || die "router port $ROUTER_PORT is duplicated across pools"
    router_ports[$ROUTER_PORT]=$pool_key
    [[ -z ${metrics_ports[$ROUTER_METRICS_PORT]+set} ]] \
      || die "metrics port $ROUTER_METRICS_PORT is duplicated across pools"
    metrics_ports[$ROUTER_METRICS_PORT]=$pool_key

    read -r -a worker_urls <<<"$ROUTER_WORKER_URLS"
    for worker_url in "${worker_urls[@]}"; do
      [[ -z ${worker_pools[$worker_url]+set} ]] \
        || die "worker URL $worker_url is duplicated in ${worker_pools[$worker_url]} and $pool_key"
      worker_pools[$worker_url]=$pool_key
    done
  done
}

validate_bundle() {
  local requirements_sha256
  local pool_key

  load_bundle
  requirements_sha256=$(sha256sum "$REQUIREMENTS_FILE" | awk '{print $1}')
  [[ "$requirements_sha256" == "$VLLM_ROUTER_REQUIREMENTS_SHA256" ]] \
    || die "requirements.lock checksum mismatch"

  [[ "$VLLM_ROUTER_VERSION" == 0.1.15 ]] || die "unexpected router version"
  [[ "$VLLM_ROUTER_TAG" == v0.1.15 ]] || die "unexpected router tag"
  [[ "$OTLP_DESTINATION_ENDPOINT" == 100.71.235.10:4317 ]] || die "unexpected OTLP destination"

  for pool_key in "${POOL_KEYS[@]}"; do
    load_pool "$pool_key"
    validate_current_pool "$pool_key"
  done
  validate_pool_uniqueness
  load_pool general

  require_file "$BUNDLE_DIR/config/otel-collector.yaml"
  require_file "$BUNDLE_DIR/systemd/echo-vllm-router.service"
  require_file "$BUNDLE_DIR/systemd/echo-vllm-router@.service"
  require_file "$BUNDLE_DIR/systemd/echo-vllm-router-otel.service"
  require_file "$BUNDLE_DIR/bin/setup.sh"
  require_file "$BUNDLE_DIR/bin/preflight-remote.sh"
  require_file "$BUNDLE_DIR/bin/install-remote.sh"
}

run_remote_preflight() {
  local target_host=$1
  local signoz_host=${OTLP_DESTINATION_ENDPOINT%:*}
  local signoz_port=${OTLP_DESTINATION_ENDPOINT##*:}
  local pool_key
  local worker_urls_csv
  local -a pool_args=()

  for pool_key in "${POOL_KEYS[@]}"; do
    load_pool "$pool_key"
    worker_urls_csv=${ROUTER_WORKER_URLS// /,}
    pool_args+=(
      "$pool_key"
      "$(pool_unit "$pool_key")"
      "$ROUTER_PORT"
      "$ROUTER_METRICS_PORT"
      "$ROUTER_EXPECTED_MODEL_ID"
      "$worker_urls_csv"
    )
  done
  load_pool general

  ssh -o BatchMode=yes "$target_host" bash -s -- \
    "$EXPECTED_HOSTNAME" \
    "$ROUTER_HOST" \
    "$signoz_host" \
    "$signoz_port" \
    "${pool_args[@]}" \
    <"$BUNDLE_DIR/bin/preflight-remote.sh"
}
