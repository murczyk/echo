#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

protected_file_exists "$SOURCE_CONFIG_FILE" || exit 0
load_source_config

require_cmd ssh
require_cmd sudo
require_cmd timeout

health_timeout=${ANALYTICS_DEPLOY_HEALTH_TIMEOUT_SECONDS:-300}
[[ "$health_timeout" =~ ^[1-9][0-9]*$ ]] \
  || die "ANALYTICS_DEPLOY_HEALTH_TIMEOUT_SECONDS must be a positive integer"

analytics_ssh_target=${ANALYTICS_SSH_TARGET:-echo@${ANALYTICS_ADDRESS%/*}}
[[ "$analytics_ssh_target" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ ]] \
  || die "invalid ANALYTICS_SSH_TARGET: $analytics_ssh_target"

log "Waiting for source table reconciliation"
sudo systemctl start echo-peerdb-table-reconcile.service \
  || die "source table reconciliation failed"

log "Running manifest-authorized targeted empty-table repairs"
"$SCRIPT_DIR/source-resnapshot-table.sh" --manifest

deadline=$((SECONDS + health_timeout))
while ((SECONDS < deadline)); do
  if timeout --foreground 60s ssh -n \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    "$analytics_ssh_target" \
    'sudo systemctl reset-failed echo-analytics-health.service >/dev/null 2>&1 || true; sudo systemctl start echo-analytics-health.service'
  then
    log "Analytics deployment health check passed"
    exit 0
  fi
  sleep 10
done

log "Final analytics schema and table status follows"
ssh -n \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  "$analytics_ssh_target" \
  'cd /opt/echo-analytics/deploy; bin/reconcile-schema.sh || true; bin/table-status.sh || true; sudo journalctl -u echo-analytics-health.service -n 40 --no-pager' \
  >&2 || true
die "analytics did not become healthy within ${health_timeout}s"
