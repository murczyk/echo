#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_source_config

require_cmd psql
require_cmd sudo
require_cmd systemctl

validate_identifier SOURCE_DB "$SOURCE_DB"
validate_identifier SOURCE_USER "$SOURCE_USER"
validate_identifier SOURCE_PUBLICATION "$SOURCE_PUBLICATION"
validate_ipv4_address SOURCE_LISTEN_ADDRESS "$SOURCE_LISTEN_ADDRESS"
validate_ipv4_address ANALYTICS_ADDRESS "$ANALYTICS_ADDRESS"

service="postgresql@${SOURCE_PG_MAJOR}-${SOURCE_PG_CLUSTER}.service"
systemctl is-active --quiet "$service" || die "$service is not active"

actual_major=$(source_local_psql -Atqc "SHOW server_version_num" | cut -c1-2)
[[ "$actual_major" == "$SOURCE_PG_MAJOR" ]] \
  || die "expected PostgreSQL $SOURCE_PG_MAJOR, found server_version_num $actual_major"

require_analytics_heartbeat_table
read_local_source_tables
require_analytics_heartbeat_selected
printf 'Selected source tables: %s\n' "${#SOURCE_TABLES[@]}"

selected_tables=$(printf '%s,' "${SOURCE_TABLES[@]}")
selected_tables=${selected_tables%,}
tables_without_identity=$(source_local_psql -Atq \
  -v selected_tables="$selected_tables" <<'SQL'
SELECT format('%I.%I', n.nspname, c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname <> 'information_schema'
  AND n.nspname !~ '^pg_'
  AND c.relreplident <> 'f'
  AND n.nspname || '.' || c.relname = ANY(string_to_array(:'selected_tables', ','))
  AND NOT EXISTS (
    SELECT FROM pg_index i
    WHERE i.indrelid = c.oid AND i.indisprimary
  )
ORDER BY 1;
SQL
)
[[ -z "$tables_without_identity" ]] \
  || die "tables without a primary key or REPLICA IDENTITY FULL: $tables_without_identity"

source_local_psql -P pager=off <<'SQL'
SELECT current_setting('wal_level') AS wal_level,
       current_setting('max_replication_slots') AS max_replication_slots,
       current_setting('max_wal_senders') AS max_wal_senders,
       current_setting('max_slot_wal_keep_size') AS max_slot_wal_keep_size,
       current_setting('listen_addresses') AS listen_addresses;

SELECT pg_size_pretty(wal_bytes) AS wal_since_reset,
       stats_reset,
       pg_size_pretty(
         (wal_bytes / GREATEST(EXTRACT(EPOCH FROM clock_timestamp() - stats_reset), 1) * 3600)::bigint
       ) AS average_wal_per_hour
FROM pg_stat_wal;

SELECT slot_name, slot_type, active, wal_status, safe_wal_size,
       invalidation_reason, inactive_since
FROM pg_replication_slots
ORDER BY slot_name;
SQL

data_dir=$(source_local_psql -Atqc "SHOW data_directory")
df -h "$data_dir"

printf '\nRequired restart settings\n'
printf '  wal_level: logical\n'
printf '  max_slot_wal_keep_size: %s\n' "$SOURCE_MAX_SLOT_WAL_KEEP_SIZE"
printf '  listen address: %s\n' "$SOURCE_LISTEN_ADDRESS"
printf '  allowed analytics CIDR: %s\n' "$ANALYTICS_ADDRESS"

log "Source preflight passed; source-configure.sh --yes performs the restart and database changes"
