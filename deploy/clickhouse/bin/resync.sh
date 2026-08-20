#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
delegate_paired_analytics_operation_if_source resync.sh "$@"
load_analytics_config
validate_runtime_identifiers
acquire_analytics_reconcile_lock
require_expected_control_release
ensure_yes "${1:-}"

start_timeout=${MIRROR_RESYNC_START_TIMEOUT_SECONDS:-300}
[[ "$start_timeout" =~ ^[1-9][0-9]*$ ]] \
  || die "MIRROR_RESYNC_START_TIMEOUT_SECONDS must be a positive integer"

peerdb_psql -v ON_ERROR_STOP=1 -c "RESYNC MIRROR IF EXISTS $MIRROR_NAME"
log "Mirror resync requested; waiting for PeerDB to leave the previous RUNNING state"

deadline=$((SECONDS + start_timeout))
while true; do
  status=$(catalog_psql -Atq \
    -v ON_ERROR_STOP=1 \
    -v mirror="$MIRROR_NAME" <<'SQL' 2>/dev/null || true
SELECT status FROM flows WHERE name = :'mirror';
SQL
  )

  case $status in
    1|'')
      ;;
    6|7|8|10)
      die "mirror entered terminal status $status while starting resync"
      ;;
    *)
      log "Mirror entered resync status $status"
      break
      ;;
  esac

  ((SECONDS < deadline)) \
    || die "mirror did not start resync within ${start_timeout}s"
  sleep 1
done

log "The replacement snapshot may increase source load and retained WAL"
