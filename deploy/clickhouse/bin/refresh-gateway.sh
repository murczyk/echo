#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config
validate_runtime_identifiers
require_cmd base64

metadata_sql=$(mktemp /tmp/echo-analytics-source-columns.XXXXXX)
trap 'rm -f -- "$metadata_sql"' EXIT
chmod 0600 "$metadata_sql"

view_count=$(clickhouse_admin --format TSVRaw --query \
  "SELECT count() FROM system.tables WHERE database = '$CLICKHOUSE_CURRENT_DB' AND engine = 'View'")
[[ "$view_count" =~ ^[0-9]+$ ]] || die "ClickHouse returned an invalid view count"
((view_count > 0)) || die "no current-state ClickHouse views exist"
clickhouse_password_b64=$(printf '%s' "$CLICKHOUSE_GATEWAY_PASSWORD" | base64 -w 0)

# Generate literals on the source server so unusual column names remain safe.
# The publication is the source of truth for the tables exposed by the mirror.
source_psql \
  -v ON_ERROR_STOP=1 \
  -v publication="$SOURCE_PUBLICATION" \
  -Atq >"$metadata_sql" <<'SQL'
SELECT pg_catalog.format(
  'INSERT INTO source_column_metadata '
  '(source_schema, source_table, target_table, column_name, ordinal_position, compatibility_type) '
  'VALUES (%L, %L, %L, %L, %s, %L);',
  n.nspname,
  c.relname,
  CASE
    WHEN n.nspname = 'public' THEN c.relname
    ELSE n.nspname || '__' || c.relname
  END,
  a.attname,
  a.attnum,
  CASE a.atttypid
    WHEN 'pg_catalog.json'::pg_catalog.regtype THEN 'json'
    WHEN 'pg_catalog.jsonb'::pg_catalog.regtype THEN 'jsonb'
    WHEN 'pg_catalog.bytea'::pg_catalog.regtype THEN 'bytea'
    WHEN 'pg_catalog.tsvector'::pg_catalog.regtype THEN 'tsvector'
    ELSE NULL
  END
)
FROM pg_catalog.pg_publication_tables publication_table
JOIN pg_catalog.pg_namespace n
  ON n.nspname = publication_table.schemaname
JOIN pg_catalog.pg_class c
  ON c.relnamespace = n.oid
 AND c.relname = publication_table.tablename
JOIN pg_catalog.pg_attribute a
  ON a.attrelid = c.oid
 AND a.attnum > 0
 AND NOT a.attisdropped
WHERE publication_table.pubname = :'publication'
ORDER BY n.nspname, c.relname, a.attnum;
SQL

[[ -s "$metadata_sql" ]] \
  || die "source publication has no column metadata: $SOURCE_PUBLICATION"

{
  printf '\\set clickhouse_password_b64 %s\n' "$clickhouse_password_b64"
  cat <<'SQL'
BEGIN;
SET LOCAL client_min_messages = warning;
CREATE TEMP TABLE source_column_metadata (
  source_schema text NOT NULL,
  source_table text NOT NULL,
  target_table text NOT NULL,
  column_name text NOT NULL,
  ordinal_position integer NOT NULL,
  compatibility_type text CHECK (
    compatibility_type IN ('json', 'jsonb', 'bytea', 'tsvector')
  )
) ON COMMIT DROP;
CREATE TEMP TABLE gateway_refresh_config (
  expected_count integer NOT NULL
) ON COMMIT DROP;
INSERT INTO gateway_refresh_config VALUES (:'expected_count');
SQL
  cat "$metadata_sql"
  cat <<'SQL'

DO $do$
BEGIN
  IF EXISTS (
    SELECT target_table
    FROM source_column_metadata
    GROUP BY target_table
    HAVING count(DISTINCT (source_schema, source_table)) <> 1
  ) THEN
    RAISE EXCEPTION 'source table names collide after PeerDB target mapping';
  END IF;

  IF (SELECT count(DISTINCT target_table) FROM source_column_metadata)
       <> (SELECT expected_count FROM gateway_refresh_config) THEN
    RAISE EXCEPTION 'source publication table count does not match ClickHouse view count';
  END IF;
END
$do$;

DROP SERVER IF EXISTS echo_clickhouse CASCADE;
DROP FUNCTION IF EXISTS public.echo_clickhouse_text_to_json(text);
DROP FUNCTION IF EXISTS public.echo_clickhouse_text_to_jsonb(text);
DROP FUNCTION IF EXISTS public.echo_clickhouse_text_to_tsvector(text);
DROP SCHEMA IF EXISTS echo_clickhouse_foreign CASCADE;
CREATE SCHEMA echo_clickhouse_foreign AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA echo_clickhouse_foreign FROM PUBLIC;

SELECT format(
  'CREATE SERVER echo_clickhouse FOREIGN DATA WRAPPER clickhouse_fdw OPTIONS (driver %L, host %L, port %L, dbname %L, secure %L)',
  'binary', '127.0.0.1', :'clickhouse_port', :'clickhouse_db', 'off'
) \gexec
SELECT format(
  'CREATE USER MAPPING FOR %I SERVER echo_clickhouse OPTIONS (user %L, password %L)',
  :'gateway_user',
  :'clickhouse_user',
  convert_from(decode(:'clickhouse_password_b64', 'base64'), 'UTF8')
) \gexec
SELECT format(
  'CREATE USER MAPPING FOR CURRENT_USER SERVER echo_clickhouse OPTIONS (user %L, password %L)',
  :'clickhouse_user',
  convert_from(decode(:'clickhouse_password_b64', 'base64'), 'UTF8')
) \gexec
SELECT format('GRANT USAGE ON FOREIGN SERVER echo_clickhouse TO %I', :'gateway_user') \gexec
SELECT format(
  'IMPORT FOREIGN SCHEMA %I FROM SERVER echo_clickhouse INTO echo_clickhouse_foreign',
  :'clickhouse_db'
) \gexec

SELECT format(
  'ALTER FOREIGN TABLE echo_clickhouse_foreign.%I ALTER COLUMN %I TYPE pg_catalog.bytea',
  metadata.target_table,
  metadata.column_name
)
FROM source_column_metadata metadata
WHERE metadata.compatibility_type = 'bytea'
ORDER BY metadata.target_table, metadata.ordinal_position
\gexec

DO $do$
DECLARE
  foreign_table record;
  select_list text;
BEGIN
  IF (
    SELECT count(*)
    FROM information_schema.foreign_tables
    WHERE foreign_table_schema = 'echo_clickhouse_foreign'
  ) <> (SELECT expected_count FROM gateway_refresh_config) THEN
    RAISE EXCEPTION 'imported foreign-table count does not match ClickHouse view count';
  END IF;

  IF EXISTS (
    WITH imported_columns AS (
      SELECT foreign_relation.foreign_table_name AS target_table,
             column_info.column_name
      FROM information_schema.foreign_tables foreign_relation
      JOIN information_schema.columns column_info
        ON column_info.table_schema = foreign_relation.foreign_table_schema
       AND column_info.table_name = foreign_relation.foreign_table_name
      WHERE foreign_relation.foreign_table_schema = 'echo_clickhouse_foreign'
    ), differing_columns AS (
      (SELECT target_table, column_name FROM source_column_metadata
       EXCEPT
       SELECT target_table, column_name FROM imported_columns)
      UNION ALL
      (SELECT target_table, column_name FROM imported_columns
       EXCEPT
       SELECT target_table, column_name FROM source_column_metadata)
    )
    SELECT FROM differing_columns
  ) THEN
    RAISE EXCEPTION 'source and imported ClickHouse columns do not match';
  END IF;

  FOR foreign_table IN
    SELECT foreign_table_name AS table_name
    FROM information_schema.foreign_tables
    WHERE foreign_table_schema = 'echo_clickhouse_foreign'
    ORDER BY foreign_table_name
  LOOP
    SELECT string_agg(
      CASE
        WHEN metadata.compatibility_type IS NULL
          OR metadata.compatibility_type = 'bytea'
          THEN format('foreign_row.%I', column_info.column_name)
        WHEN metadata.compatibility_type = 'json'
          THEN format(
            'pg_catalog.json_in(foreign_row.%1$I::pg_catalog.cstring) AS %1$I',
            column_info.column_name
          )
        WHEN metadata.compatibility_type = 'jsonb'
          THEN format(
            'pg_catalog.jsonb_in(foreign_row.%1$I::pg_catalog.cstring) AS %1$I',
            column_info.column_name
          )
        WHEN metadata.compatibility_type = 'tsvector'
          THEN format(
            'pg_catalog.tsvectorin(foreign_row.%1$I::pg_catalog.cstring) AS %1$I',
            column_info.column_name
          )
        ELSE NULL
      END,
      ', ' ORDER BY column_info.ordinal_position
    )
    INTO select_list
    FROM information_schema.columns column_info
    JOIN source_column_metadata metadata
      ON metadata.target_table = column_info.table_name
     AND metadata.column_name = column_info.column_name
    WHERE column_info.table_schema = 'echo_clickhouse_foreign'
      AND column_info.table_name = foreign_table.table_name;

    IF select_list IS NULL THEN
      RAISE EXCEPTION 'no columns found for foreign table %', foreign_table.table_name;
    END IF;

    EXECUTE format(
      'CREATE VIEW public.%1$I AS SELECT %2$s FROM echo_clickhouse_foreign.%1$I AS foreign_row',
      foreign_table.table_name,
      select_list
    );
  END LOOP;
END
$do$;

SELECT format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', view_name.table_name)
FROM information_schema.views view_name
JOIN (SELECT DISTINCT target_table FROM source_column_metadata) metadata
  ON metadata.target_table = view_name.table_name
WHERE view_name.table_schema = 'public'
\gexec
SELECT format('GRANT SELECT ON TABLE public.%I TO %I', view_name.table_name, :'gateway_user')
FROM information_schema.views view_name
JOIN (SELECT DISTINCT target_table FROM source_column_metadata) metadata
  ON metadata.target_table = view_name.table_name
WHERE view_name.table_schema = 'public'
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'gateway_user') \gexec

DO $do$
BEGIN
  IF (
    SELECT count(*)
    FROM information_schema.views public_view
    JOIN (SELECT DISTINCT target_table FROM source_column_metadata) metadata
      ON metadata.target_table = public_view.table_name
    WHERE public_view.table_schema = 'public'
  ) <> (SELECT expected_count FROM gateway_refresh_config) THEN
    RAISE EXCEPTION 'public compatibility-view count does not match ClickHouse view count';
  END IF;

  IF EXISTS (
    SELECT FROM source_column_metadata metadata
    JOIN information_schema.columns public_column
      ON public_column.table_schema = 'public'
     AND public_column.table_name = metadata.target_table
     AND public_column.column_name = metadata.column_name
    WHERE metadata.compatibility_type IS NOT NULL
      AND public_column.udt_name <> metadata.compatibility_type
  ) THEN
    RAISE EXCEPTION 'a public compatibility view has an incorrect restored type';
  END IF;
END
$do$;
COMMIT;
SQL
} | postgres_psql --dbname "$GATEWAY_DB" \
  -q \
  -v ON_ERROR_STOP=1 \
  -v expected_count="$view_count" \
  -v gateway_user="$GATEWAY_USER" \
  -v clickhouse_user="$CLICKHOUSE_GATEWAY_USER" \
  -v clickhouse_db="$CLICKHOUSE_CURRENT_DB" \
  -v clickhouse_port="${CLICKHOUSE_NATIVE_PORT:-9000}"

gateway_view_count_matches=$(PGPASSWORD=$GATEWAY_PASSWORD psql -X \
  --host 127.0.0.1 \
  --port "${ANALYTICS_GATEWAY_PORT:-5432}" \
  --username "$GATEWAY_USER" \
  --dbname "$GATEWAY_DB" \
  -v ON_ERROR_STOP=1 \
  -v expected_count="$view_count" \
  -Atq <<'SQL'
SELECT count(*) = :'expected_count'::integer
FROM information_schema.views
WHERE table_schema = 'public';
SQL
)
[[ "$gateway_view_count_matches" == t ]] \
  || die "gateway compatibility-view count does not match ClickHouse view count"

log "Refreshed $view_count gateway compatibility views"
