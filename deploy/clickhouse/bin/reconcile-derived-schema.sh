#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ANALYTICS_LIB=${ECHO_ANALYTICS_LIB:-$SCRIPT_DIR/lib.sh}
# shellcheck source=./lib.sh
source "$ANALYTICS_LIB"
load_analytics_config
validate_runtime_identifiers

derived_database="${CLICKHOUSE_CURRENT_DB}_derived"
message_callsign_view=message_callsign_v1
validate_identifier derived_database "$derived_database"
validate_identifier message_callsign_view "$message_callsign_view"

current_table_exists=$(clickhouse_admin_http "
  SELECT count()
  FROM system.tables
  WHERE database = '$CLICKHOUSE_CURRENT_DB'
    AND name = 'sigint_inbox_item'
")
[[ "$current_table_exists" == 1 ]] \
  || die "current-state ClickHouse view is missing: $CLICKHOUSE_CURRENT_DB.sigint_inbox_item"

clickhouse_admin_http "CREATE DATABASE IF NOT EXISTS \`$derived_database\`"
clickhouse_admin_http "
  CREATE VIEW IF NOT EXISTS \`$derived_database\`.\`$message_callsign_view\` AS
  SELECT
    id AS sigint_inbox_item_id,
    arrayJoin(
      JSONExtract(
        assumeNotNull(callsigns),
        'Array(Nullable(String))'
      )
    ) AS callsign
  FROM \`$CLICKHOUSE_CURRENT_DB\`.\`sigint_inbox_item\`
  WHERE callsigns IS NOT NULL
"
clickhouse_admin_http "
  GRANT SELECT ON \`$derived_database\`.* TO \`$CLICKHOUSE_GATEWAY_USER\`
"

postgres_psql --dbname "$GATEWAY_DB" \
  -q \
  -v ON_ERROR_STOP=1 \
  -v derived_database="$derived_database" \
  -v message_callsign_view="$message_callsign_view" \
  -v gateway_user="$GATEWAY_USER" <<'SQL'
BEGIN;
CREATE SCHEMA IF NOT EXISTS echo_clickhouse_derived AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA echo_clickhouse_derived FROM PUBLIC;
CREATE FOREIGN TABLE IF NOT EXISTS echo_clickhouse_derived.message_callsign (
  sigint_inbox_item_id bigint NOT NULL,
  callsign text
)
SERVER echo_clickhouse
OPTIONS (
  database :'derived_database',
  table_name :'message_callsign_view'
);
REVOKE ALL ON TABLE echo_clickhouse_derived.message_callsign FROM PUBLIC;
SELECT format(
  'GRANT USAGE ON SCHEMA echo_clickhouse_derived TO %I',
  :'gateway_user'
) \gexec
SELECT format(
  'GRANT SELECT ON TABLE echo_clickhouse_derived.message_callsign TO %I',
  :'gateway_user'
) \gexec
COMMIT;
SQL

log "Reconciled derived analytics schema"
