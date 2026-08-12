#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config

start_services=true
case ${1:-} in
  '')
    ;;
  --no-start)
    start_services=false
    ;;
  *)
    die "usage: $0 [--no-start]"
    ;;
esac

for binary in /opt/peerdb/bin/peer-flow /opt/peerdb/bin/peerdb-server /opt/temporal/bin/temporal-server /usr/local/bin/minio; do
  [[ -x "$binary" ]] || die "missing runtime binary: $binary"
done

sudo install -d -o root -g root -m 0755 /opt/echo-analytics
sudo install -d -o root -g root -m 0755 /opt/echo-analytics/bin
sudo install -o root -g root -m 0755 "$SCRIPT_DIR/lib.sh" \
  /opt/echo-analytics/bin/lib.sh
sudo install -o root -g root -m 0755 "$SCRIPT_DIR/clickhouse-system-log-policy.sh" \
  /opt/echo-analytics/bin/clickhouse-system-log-policy.sh
sudo install -o root -g root -m 0644 "$BUNDLE_DIR/versions.env" \
  /opt/echo-analytics/versions.env
for wrapper in \
  run-peer-flow.sh \
  run-peerdb-server.sh \
  run-minio.sh \
  apply-firewall.sh \
  check-analytics-health.sh \
  reconcile-schema.sh \
  reconcile-derived-schema.sh \
  reconcile-table-selection.sh \
  refresh-current-views.sh \
  refresh-gateway.sh \
  query-performance-report.sh \
  manage-system-logs.sh
do
  sudo install -m 0755 "$SCRIPT_DIR/$wrapper" "/opt/echo-analytics/bin/$wrapper"
done
for unit in "$BUNDLE_DIR"/systemd/*; do
  sudo install -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"
done

sudo systemctl daemon-reload
$start_services || {
  log "Native systemd services installed without enabling or starting the analytics target"
  exit 0
}
sudo systemctl enable echo-analytics.target
sudo systemctl restart echo-analytics.target

wait_for_command Temporal temporal --address "127.0.0.1:${TEMPORAL_PORT:-7233}" operator namespace list
if ! temporal --address "127.0.0.1:${TEMPORAL_PORT:-7233}" \
  operator namespace describe --namespace default >/dev/null 2>&1; then
  temporal --address "127.0.0.1:${TEMPORAL_PORT:-7233}" \
    operator namespace create --namespace default --retention 7d
fi
wait_for_command "Temporal default namespace" \
  temporal --address "127.0.0.1:${TEMPORAL_PORT:-7233}" \
  operator namespace describe --namespace default
wait_for_command "Temporal default namespace search attributes" \
  temporal --address "127.0.0.1:${TEMPORAL_PORT:-7233}" \
  operator search-attribute list
if ! temporal --address "127.0.0.1:${TEMPORAL_PORT:-7233}" \
  operator search-attribute list | grep -w MirrorName >/dev/null; then
  temporal --address "127.0.0.1:${TEMPORAL_PORT:-7233}" \
    operator search-attribute create --name MirrorName --type Text
fi

log "Native systemd services installed and started"
