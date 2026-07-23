#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config
validate_runtime_identifiers
read_source_tables

output=${1:-}
[[ -n "$output" ]] || die "usage: render-mirror-sql.sh OUTPUT_FILE"
source_password=$(sql_literal "$SOURCE_PASSWORD")
clickhouse_password=$(sql_literal "$CLICKHOUSE_PEERDB_PASSWORD")

declare -a mappings=()
for table in "${SOURCE_TABLES[@]}"; do
  schema=${table%%.*}
  relation=${table##*.}
  if [[ "$schema" == public ]]; then
    target=$relation
  else
    target="${schema}__${relation}"
  fi
  validate_identifier target "$target"
  mappings+=("  $table:$target")
done

{
  cat <<SQL
CREATE PEER IF NOT EXISTS $SOURCE_PEER FROM POSTGRES WITH
(
  host = '$SOURCE_HOST',
  port = $SOURCE_PORT,
  user = '$SOURCE_USER',
  password = '$source_password',
  database = '$SOURCE_DB'
);

CREATE PEER IF NOT EXISTS $CLICKHOUSE_PEER FROM CLICKHOUSE WITH
(
  host = '127.0.0.1',
  port = ${CLICKHOUSE_NATIVE_PORT:-9000},
  user = '$CLICKHOUSE_PEERDB_USER',
  password = '$clickhouse_password',
  database = '$CLICKHOUSE_RAW_DB',
  disable_tls = true
);

CREATE MIRROR IF NOT EXISTS $MIRROR_NAME
FROM $SOURCE_PEER TO $CLICKHOUSE_PEER
WITH TABLE MAPPING
(
SQL
  printf '%s,\n' "${mappings[@]}" | sed '$ s/,$//'
  cat <<SQL
)
WITH
(
  do_initial_copy = true,
  max_batch_size = ${CDC_MAX_BATCH_SIZE:-100000},
  sync_interval = ${CDC_SYNC_INTERVAL:-10},
  publication_name = '$SOURCE_PUBLICATION',
  soft_delete_col_name = '_peerdb_is_deleted',
  synced_at_col_name = '_peerdb_synced_at',
  snapshot_num_rows_per_partition = ${SNAPSHOT_NUM_ROWS_PER_PARTITION:-500000},
  snapshot_max_parallel_workers = ${SNAPSHOT_MAX_PARALLEL_WORKERS:-2},
  snapshot_num_tables_in_parallel = ${SNAPSHOT_NUM_TABLES_IN_PARALLEL:-2}
);
SQL
} >"$output"

chmod 0600 "$output"
log "Rendered secret-bearing mirror SQL to $output; delete it immediately after use"
