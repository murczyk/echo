#!/usr/bin/env bash

set -euo pipefail

: "${ROUTER_HOST:?ROUTER_HOST is required}"
: "${ROUTER_POOL:?ROUTER_POOL is required}"
: "${ROUTER_PORT:?ROUTER_PORT is required}"
: "${ROUTER_EXPECTED_MODEL_ID:?ROUTER_EXPECTED_MODEL_ID is required}"
: "${ROUTER_WORKER_URLS:?ROUTER_WORKER_URLS is required}"
: "${ROUTER_POLICY:?ROUTER_POLICY is required}"
: "${ROUTER_METRICS_HOST:?ROUTER_METRICS_HOST is required}"
: "${ROUTER_METRICS_PORT:?ROUTER_METRICS_PORT is required}"

read -r -a worker_urls <<<"$ROUTER_WORKER_URLS"
((${#worker_urls[@]} > 0)) || {
  printf 'ROUTER_WORKER_URLS contains no workers\n' >&2
  exit 1
}

for worker_url in "${worker_urls[@]}"; do
  [[ "$worker_url" =~ ^https?://[^/[:space:]]+:[0-9]+$ ]] || {
    printf 'invalid worker URL: %s\n' "$worker_url" >&2
    exit 1
  }
done

exec /opt/echo-vllm-router/current/bin/vllm-router \
  --host "$ROUTER_HOST" \
  --port "$ROUTER_PORT" \
  --worker-urls "${worker_urls[@]}" \
  --policy "$ROUTER_POLICY" \
  --prometheus-host "$ROUTER_METRICS_HOST" \
  --prometheus-port "$ROUTER_METRICS_PORT"
