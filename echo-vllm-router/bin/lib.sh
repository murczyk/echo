#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
VERSIONS_FILE="$BUNDLE_DIR/versions.env"
REQUIREMENTS_FILE="$BUNDLE_DIR/requirements.lock"
ROUTER_ENV_FILE="$BUNDLE_DIR/config/router.env"

EXPECTED_HOSTNAME=ct-echo-vllm-router
EXPECTED_MODEL_ID=google/gemma-4-26B-A4B-it
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

load_bundle() {
  require_file "$VERSIONS_FILE"
  require_file "$REQUIREMENTS_FILE"
  require_file "$ROUTER_ENV_FILE"
  # shellcheck disable=SC1090
  source "$VERSIONS_FILE"
  # shellcheck disable=SC1090
  source "$ROUTER_ENV_FILE"

  require_sha256 VLLM_ROUTER_WHEEL_SHA256 "$VLLM_ROUTER_WHEEL_SHA256"
  require_sha256 VLLM_ROUTER_REQUIREMENTS_SHA256 "$VLLM_ROUTER_REQUIREMENTS_SHA256"
  require_sha256 SIGNOZ_OTEL_COLLECTOR_ARCHIVE_SHA256 "$SIGNOZ_OTEL_COLLECTOR_ARCHIVE_SHA256"
  require_sha256 SIGNOZ_OTEL_COLLECTOR_BINARY_SHA256 "$SIGNOZ_OTEL_COLLECTOR_BINARY_SHA256"
}

validate_bundle() {
  local requirements_sha256
  local worker_url
  local initial_worker_found=0
  local -a worker_urls

  load_bundle
  requirements_sha256=$(sha256sum "$REQUIREMENTS_FILE" | awk '{print $1}')
  [[ "$requirements_sha256" == "$VLLM_ROUTER_REQUIREMENTS_SHA256" ]] \
    || die "requirements.lock checksum mismatch"

  [[ "$VLLM_ROUTER_VERSION" == 0.1.15 ]] || die "unexpected router version"
  [[ "$VLLM_ROUTER_TAG" == v0.1.15 ]] || die "unexpected router tag"
  [[ "$ROUTER_HOST" == 100.105.172.96 ]] || die "unexpected router IP"
  [[ "$ROUTER_PORT" == 8000 ]] || die "unexpected router port"
  read -r -a worker_urls <<<"$ROUTER_WORKER_URLS"
  ((${#worker_urls[@]} > 0)) || die "no router workers are configured"
  for worker_url in "${worker_urls[@]}"; do
    [[ "$worker_url" =~ ^https?://[^/[:space:]]+:[0-9]+$ ]] \
      || die "invalid worker URL: $worker_url"
    if [[ "$worker_url" == http://100.92.119.117:8000 ]]; then initial_worker_found=1; fi
  done
  [[ $initial_worker_found -eq 1 ]] || die "initial Spark worker is missing"
  [[ "$ROUTER_POLICY" == cache_aware ]] || die "unexpected routing policy"
  [[ "$ROUTER_METRICS_TARGET" == 127.0.0.1:29000 ]] || die "unexpected router metrics target"
  [[ "$OTLP_DESTINATION_ENDPOINT" == 100.71.235.10:4317 ]] || die "unexpected OTLP destination"

  require_file "$BUNDLE_DIR/config/otel-collector.yaml"
  require_file "$BUNDLE_DIR/systemd/echo-vllm-router.service"
  require_file "$BUNDLE_DIR/systemd/echo-vllm-router-otel.service"
  require_file "$BUNDLE_DIR/bin/setup.sh"
  require_file "$BUNDLE_DIR/bin/preflight-remote.sh"
  require_file "$BUNDLE_DIR/bin/install-remote.sh"
}

run_remote_preflight() {
  local target_host=$1
  local signoz_host=${OTLP_DESTINATION_ENDPOINT%:*}
  local signoz_port=${OTLP_DESTINATION_ENDPOINT##*:}
  local worker_urls_csv=${ROUTER_WORKER_URLS// /,}

  ssh -o BatchMode=yes "$target_host" bash -s -- \
    "$EXPECTED_HOSTNAME" \
    "$ROUTER_HOST" \
    "$ROUTER_PORT" \
    "$ROUTER_METRICS_PORT" \
    "$worker_urls_csv" \
    "$signoz_host" \
    "$signoz_port" \
    "$EXPECTED_MODEL_ID" \
    <"$BUNDLE_DIR/bin/preflight-remote.sh"
}
