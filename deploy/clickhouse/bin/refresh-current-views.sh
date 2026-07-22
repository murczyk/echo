#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config
validate_runtime_identifiers

mapfile -t raw_tables < <(
  clickhouse_admin --format TSVRaw --query \
    "SELECT name FROM system.tables WHERE database = '$CLICKHOUSE_RAW_DB' AND is_temporary = 0 AND NOT startsWith(name, '_peerdb_') ORDER BY name"
)
((${#raw_tables[@]} > 0)) || die "no raw ClickHouse tables exist yet"

declare -A raw_lookup=()
for table in "${raw_tables[@]}"; do
  validate_identifier raw_table "$table"
  raw_lookup["$table"]=1

  metadata_count=$(clickhouse_admin --format TSVRaw --query \
    "SELECT count() FROM system.columns WHERE database = '$CLICKHOUSE_RAW_DB' AND table = '$table' AND name IN ('_peerdb_is_deleted','_peerdb_synced_at','_peerdb_version')")
  [[ "$metadata_count" == 3 ]] || die "$CLICKHOUSE_RAW_DB.$table lacks expected PeerDB metadata columns"

  clickhouse_admin --query "
    CREATE OR REPLACE VIEW \`$CLICKHOUSE_CURRENT_DB\`.\`$table\` AS
    SELECT * EXCEPT (_peerdb_is_deleted, _peerdb_synced_at, _peerdb_version)
    FROM \`$CLICKHOUSE_RAW_DB\`.\`$table\` FINAL
    WHERE _peerdb_is_deleted = 0
  "
done

mapfile -t stale_views < <(
  clickhouse_admin --format TSVRaw --query \
    "SELECT name FROM system.tables WHERE database = '$CLICKHOUSE_CURRENT_DB' AND engine = 'View' ORDER BY name"
)
for table in "${stale_views[@]}"; do
  [[ -n "${raw_lookup[$table]:-}" ]] && continue
  validate_identifier stale_view "$table"
  clickhouse_admin --query "DROP VIEW \`$CLICKHOUSE_CURRENT_DB\`.\`$table\`"
done

log "Refreshed ${#raw_tables[@]} current-state ClickHouse views"
