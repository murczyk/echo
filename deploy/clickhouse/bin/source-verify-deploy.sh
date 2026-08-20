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
control_release=$(require_paired_control_release "$analytics_ssh_target")

reconcile_retry_attempts=${ANALYTICS_RECONCILE_DEPLOY_RETRY_ATTEMPTS:-$SOURCE_RECONCILE_DEPLOY_RETRY_ATTEMPTS_DEFAULT}
[[ "$reconcile_retry_attempts" =~ ^[1-9][0-9]*$ ]] \
  || die "ANALYTICS_RECONCILE_DEPLOY_RETRY_ATTEMPTS must be a positive integer"
reconcile_retry_delay=${ANALYTICS_RECONCILE_DEPLOY_RETRY_DELAY_SECONDS:-$SOURCE_RECONCILE_DEPLOY_RETRY_DELAY_SECONDS_DEFAULT}
[[ "$reconcile_retry_delay" =~ ^[0-9]+$ ]] \
  || die "ANALYTICS_RECONCILE_DEPLOY_RETRY_DELAY_SECONDS must be a non-negative integer"

reconciliation_log() {
  local invocation_id
  invocation_id=$(sudo systemctl show \
    echo-peerdb-table-reconcile.service \
    --property InvocationID \
    --value 2>/dev/null || true)
  if [[ "$invocation_id" =~ ^[a-f0-9]{32}$ ]]; then
    sudo journalctl \
      --quiet \
      --no-pager \
      --output cat \
      -n 40 \
      "_SYSTEMD_INVOCATION_ID=$invocation_id" 2>/dev/null || true
  else
    sudo journalctl \
      --quiet \
      --no-pager \
      --output cat \
      -n 40 \
      -u echo-peerdb-table-reconcile.service 2>/dev/null || true
  fi
}

transient_reconciliation_failure() {
  grep -Eiq \
    'deadlock detected|tuple concurrently updated|another table-selection reconciliation is already running|canceling statement due to lock timeout' \
    <<<"$1"
}

print_reconciliation_failure() {
  local title=$1 detail=$2 reconciliation_output=$3
  {
    printf '[echo-analytics] ================================================================================\n'
    printf '[echo-analytics] %s\n' "$title"
    printf '[echo-analytics]\n'
    printf '[echo-analytics] %s\n' "$detail"
    printf '[echo-analytics] Inspect the reconciliation log with:\n'
    printf '[echo-analytics] sudo journalctl -u echo-peerdb-table-reconcile.service -n 100 --no-pager\n'
    printf '[echo-analytics] -------------------------------------------------------------------------------\n'
    printf '%s\n' "$reconciliation_output"
    printf '[echo-analytics] ================================================================================\n'
  } >&2
}

reconcile_source_tables() {
  local attempt=1 manual_retry_wait_minutes reconciliation_output
  local retry_window_minutes
  retry_window_minutes=$((
    (reconcile_retry_delay * (reconcile_retry_attempts - 1) + 59) / 60
  ))
  manual_retry_wait_minutes=$retry_window_minutes
  ((manual_retry_wait_minutes > 0)) || manual_retry_wait_minutes=1

  while ! sudo systemctl start echo-peerdb-table-reconcile.service; do
    reconciliation_output=$(reconciliation_log)
    if ! transient_reconciliation_failure "$reconciliation_output"; then
      print_reconciliation_failure \
        "SOURCE TABLE RECONCILIATION FAILED" \
        "The failure was not recognized as transient, so deployment will not retry it." \
        "$reconciliation_output"
      return 1
    fi
    if ((attempt >= reconcile_retry_attempts)); then
      print_reconciliation_failure \
        "SOURCE TABLE RECONCILIATION IS STILL BLOCKED" \
        "${reconcile_retry_attempts} transient attempts failed over about ${retry_window_minutes} minutes. Wait ${manual_retry_wait_minutes} minutes, then retry this deployment once; if it fails again, investigate instead of repeatedly retrying." \
        "$reconciliation_output"
      return 1
    fi

    log "Transient reconciliation contention detected (attempt $attempt/$reconcile_retry_attempts)"
    log "Retrying automatically in ${reconcile_retry_delay}s; no operator action is needed yet"
    sleep "$reconcile_retry_delay"
    attempt=$((attempt + 1))
  done

  if ((attempt > 1)); then
    log "Source table reconciliation succeeded on attempt $attempt/$reconcile_retry_attempts"
  fi
}

log "Waiting for source table reconciliation"
reconcile_source_tables

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
    "set -euo pipefail
     test \"\$(cat /opt/echo-analytics/current/release-id)\" = '$control_release'
     sudo systemctl reset-failed echo-analytics-reconcile.service >/dev/null 2>&1 || true
     sudo systemctl start echo-analytics-reconcile.service
     sudo systemctl reset-failed echo-analytics-health.service >/dev/null 2>&1 || true
     sudo systemctl start echo-analytics-health.service"
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
  '/opt/echo-analytics/current/bin/reconcile-schema.sh --check || true; /opt/echo-analytics/current/bin/table-status.sh || true; sudo journalctl -u echo-analytics-health.service -n 40 --no-pager' \
  >&2 || true
die "analytics did not become healthy within ${health_timeout}s"
