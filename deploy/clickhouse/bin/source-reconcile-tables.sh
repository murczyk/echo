#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_source_config
ensure_yes "${1:-}"

if [[ ${ECHO_PEERDB_RECONCILE_LOCK_HELD:-false} != true ]]; then
  acquire_source_reconcile_lock
fi

require_cmd ssh
require_cmd sudo
require_cmd timeout
validate_identifier SOURCE_DB "$SOURCE_DB"
validate_identifier SOURCE_USER "$SOURCE_USER"
validate_identifier SOURCE_PUBLICATION "$SOURCE_PUBLICATION"

install_default_source_exclusions
require_analytics_heartbeat_table
read_local_source_tables
require_analytics_heartbeat_selected

[[ $(source_local_psql -Atq -v user="$SOURCE_USER" <<'SQL'
SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = :'user');
SQL
) == t ]] \
  || die "source replication role does not exist; run source-configure.sh first"
[[ $(source_local_psql -Atq -v publication="$SOURCE_PUBLICATION" <<'SQL'
SELECT EXISTS (SELECT FROM pg_publication WHERE pubname = :'publication');
SQL
) == t ]] \
  || die "source publication does not exist; run source-configure.sh first"

analytics_ssh_target=${ANALYTICS_SSH_TARGET:-echo@${ANALYTICS_ADDRESS%/*}}
[[ "$analytics_ssh_target" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ ]] \
  || die "invalid ANALYTICS_SSH_TARGET: $analytics_ssh_target"
control_release=$(require_paired_control_release "$analytics_ssh_target")

run_remote_reconcile() {
  ssh -n \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    "$analytics_ssh_target" \
    "sudo -n env ECHO_ANALYTICS_EXPECTED_CONTROL_RELEASE=$control_release /opt/echo-analytics/current/bin/reconcile-table-selection.sh $1"
}

timeout --foreground 30s \
  ssh -n \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    "$analytics_ssh_target" \
    'test -x /opt/echo-analytics/current/bin/reconcile-table-selection.sh' \
  || die "analytics reconciliation script is unavailable on $analytics_ssh_target"

reconciliation_complete=false
warn_if_incomplete() {
  $reconciliation_complete && return 0
  log "Table reconciliation did not complete; the mirror may remain paused to avoid resuming mismatched schemas."
  log "Retained WAL will grow until the issue is fixed. Resolve the reported error and rerun this command promptly."
  log "If this followed a schema migration, verify deploy/clickhouse/migration-impact.json."
  log "See deploy/clickhouse/README.md: Mirror, current views, and gateway."
}
trap warn_if_incomplete EXIT

log "Pausing the mirror on $analytics_ssh_target"
run_remote_reconcile --pause
retry_source_reconciliation_step \
  "Source table-access reconciliation" reconcile_source_table_access
retry_source_reconciliation_step \
  "Source publication reconciliation" reconcile_source_publication

log "Applying the table selection to PeerDB, ClickHouse, and the gateway"
run_remote_reconcile --yes
retry_source_reconciliation_step \
  "Excluded replica-identity reset" reset_excluded_replica_identities
source_local_psql -q -v ON_ERROR_STOP=1 \
  -c "SELECT pg_logical_emit_message(true, 'echo_peerdb_table_selection', 'reconciled')"
record_source_table_selection_fingerprint

reconciliation_complete=true
log "Source and analytics table selections are reconciled"
