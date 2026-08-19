#!/usr/bin/env bash
set -euo pipefail
TARGET_HOST=${1:-${TARGET_HOST:-echo-document-extractor}}
ssh -o BatchMode=yes "$TARGET_HOST" sudo bash -s <<'REMOTE'
set -euo pipefail
units=(echo-document-extractor-firewall.service echo-document-extractor.service echo-document-extractor-worker.service echo-document-extractor-host-cpu-exporter.service echo-document-extractor-otel.service)
/opt/echo-document-extractor/bin/configure-firewall.sh check >/dev/null
systemd-analyze verify "${units[@]/#//lib/systemd/system/}"
for unit in "${units[@]}"; do
  systemctl is-enabled --quiet "$unit"
  systemctl is-active --quiet "$unit"
done
/opt/echo-document-extractor/bin/verify-models.sh >/dev/null
[[ -x /opt/echo-document-extractor/runtime/current/bin/python ]]
source /etc/echo-document-extractor/secret.env
base=http://100.93.77.92:8000
curl -fsS "$base/health/live" | grep -F '"live"' >/dev/null
curl -fsS "$base/health/ready" | grep -F '"ready"' >/dev/null
ready=0
for _ in $(seq 1 120); do
  if curl -fsS -H "Authorization: Bearer $ECHO_DOCUMENT_EXTRACTOR_TOKEN" "$base/v1/status" \
    | python3 -c 'import json,sys; value=json.load(sys.stdin); assert all(item["healthy"] for item in value["routers"]); assert value["paddle"]["required"] and value["paddle"]["ready"]' \
    >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 5
done
(( ready )) || { printf 'worker/Paddle/router readiness timed out\n' >&2; exit 1; }
[[ $(curl -sS -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer invalid' "$base/v1/status") == 401 ]]
curl -fsS http://127.0.0.1:9100/metrics | grep -F echo_host_cpu_seconds_total >/dev/null
curl -fsS http://127.0.0.1:29000/metrics | grep -F echo_document_extractor_process_info >/dev/null
worker_metrics_ready=0
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:29001/metrics \
    | grep -F echo_document_extractor_process_info >/dev/null 2>&1; then
    worker_metrics_ready=1
    break
  fi
  sleep 2
done
(( worker_metrics_ready )) || { printf 'worker metrics readiness timed out\n' >&2; exit 1; }
REMOTE
printf 'Extractor verification passed on %s\n' "$TARGET_HOST"
