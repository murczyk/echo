#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
delegate_paired_analytics_operation_if_source finish-resync.sh "$@"
load_analytics_config
validate_runtime_identifiers
acquire_analytics_reconcile_lock
require_expected_control_release

timeout=${MIRROR_RESYNC_TIMEOUT_SECONDS:-7200}
poll_interval=${MIRROR_RESYNC_POLL_SECONDS:-5}
health_attempts=${MIRROR_RESYNC_HEALTH_ATTEMPTS:-3}
[[ "$timeout" =~ ^[1-9][0-9]*$ ]] \
  || die "MIRROR_RESYNC_TIMEOUT_SECONDS must be a positive integer"
[[ "$poll_interval" =~ ^[1-9][0-9]*$ ]] \
  || die "MIRROR_RESYNC_POLL_SECONDS must be a positive integer"
[[ "$health_attempts" =~ ^[1-9][0-9]*$ ]] \
  || die "MIRROR_RESYNC_HEALTH_ATTEMPTS must be a positive integer"

mirror_status_name() {
  case $1 in
    0) printf UNKNOWN ;;
    1) printf RUNNING ;;
    2) printf PAUSED ;;
    3) printf PAUSING ;;
    4) printf SETUP ;;
    5) printf SNAPSHOT ;;
    6) printf TERMINATING ;;
    7) printf TERMINATED ;;
    8) printf COMPLETED ;;
    9) printf RESYNC ;;
    10) printf FAILED ;;
    11) printf MODIFYING ;;
    *) printf 'INVALID:%s' "${1:-missing}" ;;
  esac
}

deadline=$((SECONDS + timeout))
previous_status=
while true; do
  status=$(catalog_psql -Atq \
    -v ON_ERROR_STOP=1 \
    -v mirror="$MIRROR_NAME" <<'SQL' 2>/dev/null || true
SELECT status FROM flows WHERE name = :'mirror';
SQL
  )

  if [[ "$status" != "$previous_status" ]]; then
    log "Mirror status: $(mirror_status_name "$status")"
    previous_status=$status
  fi

  case $status in
    1)
      break
      ;;
    6|7|8|10)
      die "mirror did not complete resync: $(mirror_status_name "$status")"
      ;;
  esac

  ((SECONDS < deadline)) \
    || die "mirror did not become healthy within ${timeout}s"
  sleep "$poll_interval"
done

"$SCRIPT_DIR/refresh-current-views.sh"
"$SCRIPT_DIR/refresh-gateway.sh"
"$SCRIPT_DIR/reconcile-if-needed.sh"

for ((attempt = 1; attempt <= health_attempts; attempt++)); do
  if "$SCRIPT_DIR/check-analytics-health.sh"; then
    log "Mirror resync completed and analytics is healthy"
    exit 0
  fi
  if ((attempt < health_attempts)); then
    log "Analytics health check failed; retrying ($attempt/$health_attempts)"
  fi
done

die "analytics did not become healthy after $health_attempts checks"
