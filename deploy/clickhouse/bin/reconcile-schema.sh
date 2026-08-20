#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config
validate_runtime_identifiers

check_only=false
case ${1:-} in
  '')
    ;;
  --check)
    check_only=true
    ;;
  *)
    die "usage: $0 [--check]"
    ;;
esac
acquire_analytics_reconcile_lock
require_expected_control_release

print_schema_difference() {
  local expected_label=$1 actual_label=$2 expected=$3 actual=$4
  log "Columns present only in $expected_label:"
  comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") \
    | sed 's/^/  /' >&2
  log "Columns present only in $actual_label:"
  comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") \
    | sed 's/^/  /' >&2
}

source_columns() {
  source_psql -Atq -F $'\t' \
    -v ON_ERROR_STOP=1 \
    -v publication="$SOURCE_PUBLICATION" <<'SQL'
SELECT CASE
         WHEN publication_table.schemaname = 'public'
           THEN publication_table.tablename
         ELSE publication_table.schemaname || '__' || publication_table.tablename
       END,
       attribute.attname
FROM pg_catalog.pg_publication_tables publication_table
JOIN pg_catalog.pg_namespace namespace
  ON namespace.nspname = publication_table.schemaname
JOIN pg_catalog.pg_class relation
  ON relation.relnamespace = namespace.oid
 AND relation.relname = publication_table.tablename
JOIN pg_catalog.pg_attribute attribute
  ON attribute.attrelid = relation.oid
 AND attribute.attnum > 0
 AND NOT attribute.attisdropped
WHERE publication_table.pubname = :'publication'
ORDER BY 1, 2;
SQL
}

clickhouse_raw_columns() {
  clickhouse_admin_http "
    SELECT table, name
    FROM system.columns
    WHERE database = '$CLICKHOUSE_RAW_DB'
      AND NOT startsWith(table, '_peerdb_')
      AND name NOT IN ('_peerdb_is_deleted', '_peerdb_synced_at', '_peerdb_version')
    ORDER BY table, name
  "
}

clickhouse_current_columns() {
  clickhouse_admin_http "
    SELECT columns.table, columns.name
    FROM system.columns columns
    JOIN system.tables tables
      ON tables.database = columns.database
     AND tables.name = columns.table
    WHERE columns.database = '$CLICKHOUSE_CURRENT_DB'
      AND tables.engine = 'View'
    ORDER BY columns.table, columns.name
  "
}

gateway_columns() {
  postgres_psql --dbname "$GATEWAY_DB" -Atq -F $'\t' \
    -v ON_ERROR_STOP=1 <<'SQL'
SELECT columns.table_name, columns.column_name
FROM information_schema.columns columns
JOIN information_schema.views views
  ON views.table_schema = columns.table_schema
 AND views.table_name = columns.table_name
JOIN information_schema.foreign_tables foreign_tables
  ON foreign_tables.foreign_table_schema = 'echo_clickhouse_foreign'
 AND foreign_tables.foreign_table_name = views.table_name
WHERE columns.table_schema = 'public'
ORDER BY columns.table_name, columns.column_name;
SQL
}

source_schema=$(source_columns)
raw_schema=$(clickhouse_raw_columns)
[[ -n "$source_schema" ]] || die "source publication has no columns"
if [[ "$source_schema" != "$raw_schema" ]]; then
  print_schema_difference "the source publication" "raw ClickHouse" \
    "$source_schema" "$raw_schema"
  die "source and raw ClickHouse schemas differ; waiting for PeerDB schema propagation or resync"
fi

current_schema=$(clickhouse_current_columns)
gateway_schema=$(gateway_columns)
refresh_current=false
refresh_gateway=false

if [[ "$source_schema" != "$current_schema" ]]; then
  refresh_current=true
  refresh_gateway=true
elif [[ "$source_schema" != "$gateway_schema" ]]; then
  refresh_gateway=true
fi

if $check_only && [[ "$refresh_current" == true || "$refresh_gateway" == true ]]; then
  if [[ "$refresh_current" == true ]]; then
    print_schema_difference "the source publication" "current ClickHouse views" \
      "$source_schema" "$current_schema"
  fi
  if [[ "$refresh_gateway" == true ]]; then
    print_schema_difference "the source publication" "the PostgreSQL gateway" \
      "$source_schema" "$gateway_schema"
  fi
  die "analytics schema drift detected"
fi

if [[ "$refresh_current" == true ]]; then
  log "Current-state ClickHouse schema drift detected; refreshing views"
  "$SCRIPT_DIR/refresh-current-views.sh"
  current_schema=$(clickhouse_current_columns)
  [[ "$source_schema" == "$current_schema" ]] \
    || die "current-state ClickHouse schema still differs after refresh"
fi

if [[ "$refresh_gateway" == true ]]; then
  log "Gateway schema drift detected; refreshing foreign tables and compatibility views"
  "$SCRIPT_DIR/refresh-gateway.sh"
  gateway_schema=$(gateway_columns)
  [[ "$source_schema" == "$gateway_schema" ]] \
    || die "gateway schema still differs after refresh"
fi

log "Analytics schemas are reconciled"
