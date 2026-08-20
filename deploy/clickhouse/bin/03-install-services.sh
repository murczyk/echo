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

control_release=$(control_bundle_release_id "$BUNDLE_DIR")
sudo env ECHO_ANALYTICS_CONTROL_START_TIMERS="$start_services" \
  "$SCRIPT_DIR/install-control-release.sh" analytics "$control_release"
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
