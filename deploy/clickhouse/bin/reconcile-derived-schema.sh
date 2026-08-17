#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ANALYTICS_LIB=${ECHO_ANALYTICS_LIB:-$SCRIPT_DIR/lib.sh}
# shellcheck source=./lib.sh
source "$ANALYTICS_LIB"
load_analytics_config
validate_runtime_identifiers

# Source deploys can stream this script before the analytics library is updated.
: "${ANALYTICS_SCHEMA_RECONCILE_LOCK_NAME:=echo_analytics_schema_reconciliation}"
if ! declare -F print_analytics_schema_reconcile_lock_sql >/dev/null; then
  print_analytics_schema_reconcile_lock_sql() {
    cat <<'SQL'
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(:'schema_reconcile_lock_name', 0)
) AS schema_reconcile_lock_acquired
\gset
SQL
  }
fi

derived_database="${CLICKHOUSE_CURRENT_DB}_derived"
metadata_database="${CLICKHOUSE_CURRENT_DB}_meta"
message_callsign_view=message_callsign_v2
message_aor_link_view=message_aor_link_v1
message_network_link_view=message_network_link_v1
network_link_table=sigint_inbox_item_network_by_message_v1
network_link_ingest_view=sigint_inbox_item_network_by_message_ingest_v1
validate_identifier derived_database "$derived_database"
validate_identifier metadata_database "$metadata_database"
validate_identifier message_callsign_view "$message_callsign_view"
validate_identifier message_aor_link_view "$message_aor_link_view"
validate_identifier message_network_link_view "$message_network_link_view"
validate_identifier network_link_table "$network_link_table"
validate_identifier network_link_ingest_view "$network_link_ingest_view"

reconcile_query_index() {
  local table=$1
  local index=$2
  local expression=$3
  local type=$4
  local granularity=$5
  local table_exists table_uuid actual_definition expected_definition state_exists

  validate_identifier query_index_table "$table"
  validate_identifier query_index_name "$index"
  validate_identifier query_index_expression "$expression"
  [[ "$type" == minmax ]] || die "unsupported query index type: $type"
  [[ "$granularity" =~ ^[1-9][0-9]*$ ]] \
    || die "query index granularity must be a positive integer"

  table_exists=$(clickhouse_admin_http "
    SELECT count()
    FROM system.tables
    WHERE database = '$CLICKHOUSE_RAW_DB'
      AND name = '$table'
  ")
  if [[ "$table_exists" != 1 ]]; then
    log "Skipping query index for missing raw table: $CLICKHOUSE_RAW_DB.$table"
    return
  fi

  table_uuid=$(clickhouse_admin_http "
    SELECT toString(uuid)
    FROM system.tables
    WHERE database = '$CLICKHOUSE_RAW_DB'
      AND name = '$table'
  ")
  [[ "$table_uuid" =~ ^[0-9a-fA-F-]{36}$ ]] \
    || die "could not resolve table UUID for $CLICKHOUSE_RAW_DB.$table"

  expected_definition="$expression|$type|$granularity"
  actual_definition=$(clickhouse_admin_http "
    SELECT concat(expr, '|', type_full, '|', toString(granularity))
    FROM system.data_skipping_indices
    WHERE database = '$CLICKHOUSE_RAW_DB'
      AND table = '$table'
      AND name = '$index'
  ")
  if [[ -z "$actual_definition" ]]; then
    clickhouse_admin_http "
      ALTER TABLE \`$CLICKHOUSE_RAW_DB\`.\`$table\`
      ADD INDEX IF NOT EXISTS \`$index\` \`$expression\`
      TYPE $type GRANULARITY $granularity
    "
  elif [[ "$actual_definition" != "$expected_definition" ]]; then
    die "query index definition drift for $CLICKHOUSE_RAW_DB.$table.$index: $actual_definition"
  fi

  state_exists=$(clickhouse_admin_http "
    SELECT count()
    FROM \`$metadata_database\`.\`query_index_reconciliation\`
    FINAL
    WHERE raw_database = '$CLICKHOUSE_RAW_DB'
      AND table_name = '$table'
      AND index_name = '$index'
      AND table_uuid = toUUID('$table_uuid')
      AND definition = '$expected_definition'
  ")
  [[ "$state_exists" == 0 ]] || return 0

  log "Materializing query index $CLICKHOUSE_RAW_DB.$table.$index"
  clickhouse_admin \
    --receive_timeout 300 \
    --query "
      ALTER TABLE \`$CLICKHOUSE_RAW_DB\`.\`$table\`
      MATERIALIZE INDEX \`$index\`
      SETTINGS mutations_sync = 1
    "
  clickhouse_admin_http "
    INSERT INTO \`$metadata_database\`.\`query_index_reconciliation\`
    (
      raw_database,
      table_name,
      index_name,
      table_uuid,
      definition,
      reconciled_at
    )
    VALUES
    (
      '$CLICKHOUSE_RAW_DB',
      '$table',
      '$index',
      toUUID('$table_uuid'),
      '$expected_definition',
      now64()
    )
  "
}

reconcile_network_link_table() {
  local raw_table=sigint_inbox_item_network
  local raw_uuid state_exists target_exists ingest_exists

  raw_uuid=$(clickhouse_admin_http "
    SELECT toString(uuid)
    FROM system.tables
    WHERE database = '$CLICKHOUSE_RAW_DB'
      AND name = '$raw_table'
  ")
  [[ "$raw_uuid" =~ ^[0-9a-fA-F-]{36}$ ]] \
    || die "could not resolve table UUID for $CLICKHOUSE_RAW_DB.$raw_table"

  state_exists=$(clickhouse_admin_http "
    SELECT count()
    FROM \`$metadata_database\`.\`derived_table_reconciliation\`
    FINAL
    WHERE raw_database = '$CLICKHOUSE_RAW_DB'
      AND raw_table = '$raw_table'
      AND raw_table_uuid = toUUID('$raw_uuid')
      AND derived_database = '$derived_database'
      AND derived_table = '$network_link_table'
  ")
  target_exists=$(clickhouse_admin_http "
    SELECT count()
    FROM system.tables
    WHERE database = '$derived_database'
      AND name = '$network_link_table'
      AND engine = 'ReplacingMergeTree'
  ")
  ingest_exists=$(clickhouse_admin_http "
    SELECT count()
    FROM system.tables
    WHERE database = '$derived_database'
      AND name = '$network_link_ingest_view'
      AND engine = 'MaterializedView'
  ")
  if [[ "$state_exists" == 1 && "$target_exists" == 1 && "$ingest_exists" == 1 ]]; then
    return
  fi

  log "Rebuilding message-ordered network links for raw table UUID $raw_uuid"
  clickhouse_admin \
    --receive_timeout 600 \
    --multiquery \
    --query "
      DROP VIEW IF EXISTS
        \`$derived_database\`.\`$message_aor_link_view\`;
      DROP VIEW IF EXISTS
        \`$derived_database\`.\`$message_network_link_view\`;
      DROP VIEW IF EXISTS
        \`$derived_database\`.\`$network_link_ingest_view\`;
      DROP TABLE IF EXISTS
        \`$derived_database\`.\`$network_link_table\`;
      CREATE TABLE
        \`$derived_database\`.\`$network_link_table\`
      (
        id Int64,
        sigint_inbox_item_id Int64,
        sigint_network_id Int64,
        created_at DateTime64(6),
        _peerdb_synced_at DateTime64(9),
        _peerdb_is_deleted UInt8,
        _peerdb_version UInt64
      )
      ENGINE = ReplacingMergeTree(
        _peerdb_version,
        _peerdb_is_deleted
      )
      ORDER BY (sigint_inbox_item_id, id);
      CREATE MATERIALIZED VIEW
        \`$derived_database\`.\`$network_link_ingest_view\`
      TO \`$derived_database\`.\`$network_link_table\`
      AS
      SELECT
        id,
        sigint_inbox_item_id,
        sigint_network_id,
        created_at,
        _peerdb_synced_at,
        _peerdb_is_deleted,
        _peerdb_version
      FROM \`$CLICKHOUSE_RAW_DB\`.\`$raw_table\`;
      INSERT INTO \`$derived_database\`.\`$network_link_table\`
      SELECT
        id,
        sigint_inbox_item_id,
        sigint_network_id,
        created_at,
        _peerdb_synced_at,
        _peerdb_is_deleted,
        _peerdb_version
      FROM \`$CLICKHOUSE_RAW_DB\`.\`$raw_table\`;
    "
  clickhouse_admin_http "
    INSERT INTO \`$metadata_database\`.\`derived_table_reconciliation\`
    (
      raw_database,
      raw_table,
      raw_table_uuid,
      derived_database,
      derived_table,
      reconciled_at
    )
    VALUES
    (
      '$CLICKHOUSE_RAW_DB',
      '$raw_table',
      toUUID('$raw_uuid'),
      '$derived_database',
      '$network_link_table',
      now64()
    )
  "
}

current_table_exists=$(clickhouse_admin_http "
  SELECT count()
  FROM system.tables
  WHERE database = '$CLICKHOUSE_CURRENT_DB'
    AND name = 'sigint_inbox_item'
")
[[ "$current_table_exists" == 1 ]] \
  || die "current-state ClickHouse view is missing: $CLICKHOUSE_CURRENT_DB.sigint_inbox_item"

clickhouse_admin_http "CREATE DATABASE IF NOT EXISTS \`$metadata_database\`"
clickhouse_admin_http "
  CREATE TABLE IF NOT EXISTS
  \`$metadata_database\`.\`query_index_reconciliation\`
  (
    raw_database String,
    table_name String,
    index_name String,
    table_uuid UUID,
    definition String,
    reconciled_at DateTime64(9)
  )
  ENGINE = ReplacingMergeTree(reconciled_at)
  ORDER BY (raw_database, table_name, index_name)
"
clickhouse_admin_http "
  CREATE TABLE IF NOT EXISTS
  \`$metadata_database\`.\`derived_table_reconciliation\`
  (
    raw_database String,
    raw_table String,
    raw_table_uuid UUID,
    derived_database String,
    derived_table String,
    reconciled_at DateTime64(9)
  )
  ENGINE = ReplacingMergeTree(reconciled_at)
  ORDER BY (raw_database, raw_table, derived_database, derived_table)
"

while IFS='|' read -r table index expression type granularity; do
  [[ -n "$table" ]] || continue
  reconcile_query_index \
    "$table" \
    "$index" \
    "$expression" \
    "$type" \
    "$granularity"
done <<'QUERY_INDEXES'
sigint_inbox_item|echo_datetime_minmax_v1|datetime|minmax|1
signal_message|echo_timestamp_minmax_v1|timestamp|minmax|1
signal_message_group|echo_signal_message_id_minmax_v1|signal_message_id|minmax|1
sigint_inbox_item_tag|echo_inbox_item_id_minmax_v1|sigint_inbox_item_id|minmax|1
sigint_inbox_item_network|echo_inbox_item_id_minmax_v1|sigint_inbox_item_id|minmax|1
QUERY_INDEXES

clickhouse_admin_http "CREATE DATABASE IF NOT EXISTS \`$derived_database\`"
reconcile_network_link_table
clickhouse_admin_http "
  CREATE VIEW IF NOT EXISTS \`$derived_database\`.\`$message_network_link_view\` AS
  SELECT
    sigint_inbox_item_id,
    sigint_network_id
  FROM \`$derived_database\`.\`$network_link_table\` FINAL
"
callsign_table_exists=$(clickhouse_admin_http "
  SELECT count()
  FROM system.tables
  WHERE database = '$CLICKHOUSE_CURRENT_DB'
    AND name = 'sigint_inbox_item_callsign'
")
if [[ "$callsign_table_exists" == 1 ]]; then
  clickhouse_admin_http "
    CREATE OR REPLACE VIEW \`$derived_database\`.\`$message_callsign_view\` AS
    SELECT DISTINCT
      sigint_inbox_item_id,
      callsign
    FROM \`$CLICKHOUSE_CURRENT_DB\`.\`sigint_inbox_item_callsign\`
    WHERE NOT deleted
  "
else
  log "Normalized callsign table is not mirrored yet; retaining the existing callsign view"
fi
clickhouse_admin_http "
  CREATE VIEW IF NOT EXISTS \`$derived_database\`.\`$message_aor_link_view\` AS
  SELECT
    message_group.signal_message_id AS sigint_inbox_item_id,
    group_aor.aor_id AS aor_id,
    aor.left_bound AS left_bound,
    aor.right_bound AS right_bound
  FROM \`$CLICKHOUSE_CURRENT_DB\`.\`signal_message_group\` AS message_group
  INNER JOIN \`$CLICKHOUSE_CURRENT_DB\`.\`signal_group_aor\` AS group_aor
    ON group_aor.master_key = message_group.group_master_key
  INNER JOIN \`$CLICKHOUSE_CURRENT_DB\`.\`area_of_responsibility\` AS aor
    ON aor.id = group_aor.aor_id
  UNION ALL
  SELECT
    inbox_network.sigint_inbox_item_id AS sigint_inbox_item_id,
    network_aor.aor_id AS aor_id,
    aor.left_bound AS left_bound,
    aor.right_bound AS right_bound
  FROM \`$derived_database\`.\`$network_link_table\` AS inbox_network FINAL
  INNER JOIN \`$CLICKHOUSE_CURRENT_DB\`.\`sigint_network\` AS network
    ON network.id = inbox_network.sigint_network_id
  INNER JOIN \`$CLICKHOUSE_CURRENT_DB\`.\`sigint_network_aor\` AS network_aor
    ON network_aor.network_id = network.id
  INNER JOIN \`$CLICKHOUSE_CURRENT_DB\`.\`area_of_responsibility\` AS aor
    ON aor.id = network_aor.aor_id
  WHERE NOT network.deleted
"
clickhouse_admin_http "
  GRANT SELECT ON \`$derived_database\`.* TO \`$CLICKHOUSE_GATEWAY_USER\`
"

{
  cat <<'SQL'
BEGIN;
SQL
  print_analytics_schema_reconcile_lock_sql
  cat <<'SQL'
CREATE SCHEMA IF NOT EXISTS echo_clickhouse_derived AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA echo_clickhouse_derived FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS echo_clickhouse_derived_foreign
  AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA echo_clickhouse_derived_foreign FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class
    JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
    WHERE pg_namespace.nspname = 'echo_clickhouse_derived'
      AND pg_class.relname = 'message_callsign'
      AND pg_class.relkind = 'f'
  ) THEN
    DROP FOREIGN TABLE echo_clickhouse_derived.message_callsign;
  END IF;
END
$$;
DO $$
DECLARE
  relation_name text;
  relation_kind "char";
  relation_server oid;
  expected_server oid;
BEGIN
  SELECT oid
  INTO expected_server
  FROM pg_foreign_server
  WHERE srvname = 'echo_clickhouse';

  IF expected_server IS NULL THEN
    RAISE EXCEPTION 'foreign server echo_clickhouse is missing';
  END IF;

  FOR relation_name IN
    SELECT unnest(ARRAY[
      'message_callsign',
      'message_aor_link',
      'message_network_link'
    ])
  LOOP
    relation_kind := NULL;
    relation_server := NULL;
    SELECT relation.relkind, foreign_table.ftserver
    INTO relation_kind, relation_server
    FROM pg_class relation
    JOIN pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_foreign_table foreign_table
      ON foreign_table.ftrelid = relation.oid
    WHERE namespace.nspname = 'echo_clickhouse_derived_foreign'
      AND relation.relname = relation_name;

    IF relation_kind IS NULL THEN
      CONTINUE;
    END IF;
    IF relation_kind <> 'f' THEN
      RAISE EXCEPTION
        'unexpected relation kind for echo_clickhouse_derived_foreign.%: %',
        relation_name,
        relation_kind;
    END IF;
    IF relation_server IS DISTINCT FROM expected_server THEN
      EXECUTE format(
        'DROP VIEW IF EXISTS %I.%I',
        'echo_clickhouse_derived',
        relation_name
      );
      EXECUTE format(
        'DROP FOREIGN TABLE %I.%I',
        'echo_clickhouse_derived_foreign',
        relation_name
      );
    END IF;
  END LOOP;
END
$$;
CREATE FOREIGN TABLE IF NOT EXISTS
echo_clickhouse_derived_foreign.message_callsign (
  sigint_inbox_item_id bigint NOT NULL,
  callsign text
)
SERVER echo_clickhouse
OPTIONS (
  database :'derived_database',
  table_name :'message_callsign_view',
  engine 'View'
);
ALTER FOREIGN TABLE echo_clickhouse_derived_foreign.message_callsign
  OPTIONS (SET table_name :'message_callsign_view');
REVOKE ALL ON TABLE echo_clickhouse_derived_foreign.message_callsign
  FROM PUBLIC;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
    WHERE pg_namespace.nspname = 'echo_clickhouse_derived'
      AND pg_class.relname = 'message_callsign'
      AND pg_class.relkind = 'v'
  ) THEN
    CREATE VIEW echo_clickhouse_derived.message_callsign AS
    SELECT sigint_inbox_item_id, callsign
    FROM echo_clickhouse_derived_foreign.message_callsign;
  END IF;
END
$$;
REVOKE ALL ON TABLE echo_clickhouse_derived.message_callsign FROM PUBLIC;
CREATE FOREIGN TABLE IF NOT EXISTS
echo_clickhouse_derived_foreign.message_aor_link (
  sigint_inbox_item_id bigint NOT NULL,
  aor_id bigint NOT NULL,
  left_bound double precision NOT NULL,
  right_bound double precision NOT NULL
)
SERVER echo_clickhouse
OPTIONS (
  database :'derived_database',
  table_name :'message_aor_link_view',
  engine 'View'
);
REVOKE ALL ON TABLE echo_clickhouse_derived_foreign.message_aor_link
  FROM PUBLIC;
CREATE OR REPLACE VIEW echo_clickhouse_derived.message_aor_link AS
SELECT sigint_inbox_item_id, aor_id, left_bound, right_bound
FROM echo_clickhouse_derived_foreign.message_aor_link;
REVOKE ALL ON TABLE echo_clickhouse_derived.message_aor_link FROM PUBLIC;
CREATE FOREIGN TABLE IF NOT EXISTS
echo_clickhouse_derived_foreign.message_network_link (
  sigint_inbox_item_id bigint NOT NULL,
  sigint_network_id bigint NOT NULL
)
SERVER echo_clickhouse
OPTIONS (
  database :'derived_database',
  table_name :'message_network_link_view',
  engine 'View'
);
REVOKE ALL ON TABLE echo_clickhouse_derived_foreign.message_network_link
  FROM PUBLIC;
CREATE OR REPLACE VIEW echo_clickhouse_derived.message_network_link AS
SELECT sigint_inbox_item_id, sigint_network_id
FROM echo_clickhouse_derived_foreign.message_network_link;
REVOKE ALL ON TABLE echo_clickhouse_derived.message_network_link FROM PUBLIC;
SELECT format(
  'GRANT USAGE ON SCHEMA echo_clickhouse_derived TO %I',
  :'gateway_user'
) \gexec
SELECT format(
  'GRANT SELECT ON TABLE echo_clickhouse_derived.message_callsign TO %I',
  :'gateway_user'
) \gexec
SELECT format(
  'GRANT SELECT ON TABLE echo_clickhouse_derived.message_aor_link TO %I',
  :'gateway_user'
) \gexec
SELECT format(
  'GRANT SELECT ON TABLE echo_clickhouse_derived.message_network_link TO %I',
  :'gateway_user'
) \gexec
COMMIT;
SQL
} | postgres_psql --dbname "$GATEWAY_DB" \
  -q \
  -v ON_ERROR_STOP=1 \
  -v schema_reconcile_lock_name="$ANALYTICS_SCHEMA_RECONCILE_LOCK_NAME" \
  -v derived_database="$derived_database" \
  -v message_callsign_view="$message_callsign_view" \
  -v message_aor_link_view="$message_aor_link_view" \
  -v message_network_link_view="$message_network_link_view" \
  -v gateway_user="$GATEWAY_USER"

log "Reconciled derived analytics schema"
