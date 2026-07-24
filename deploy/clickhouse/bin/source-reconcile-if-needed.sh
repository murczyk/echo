#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

protected_file_exists "$SOURCE_CONFIG_FILE" || exit 0

load_source_config
acquire_source_reconcile_lock

require_cmd sha256sum
require_analytics_heartbeat_table
read_local_source_tables
require_analytics_heartbeat_selected

desired_fingerprint=$(source_table_selection_fingerprint)
publication_fingerprint=$(source_publication_fingerprint)
recorded_fingerprint=
if [[ -r "$SOURCE_RECONCILE_FINGERPRINT_FILE" ]]; then
  read -r recorded_fingerprint <"$SOURCE_RECONCILE_FINGERPRINT_FILE"
fi

# Both installed state fingerprints must independently match the desired file.
# shellcheck disable=SC2055
if [[ "$desired_fingerprint" != "$publication_fingerprint" \
  || "$desired_fingerprint" != "$recorded_fingerprint" ]]; then
  log "Table-selection drift detected; starting coordinated reconciliation"
  ECHO_PEERDB_RECONCILE_LOCK_HELD=true \
    "$SCRIPT_DIR/source-reconcile-tables.sh" --yes
fi

"$SCRIPT_DIR/source-reconcile-derived-schema.sh"
