#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
if [[ ${ECHO_GATEWAY_TEST_MODE:-false} != true ]]; then
load_analytics_config
validate_runtime_identifiers
acquire_analytics_reconcile_lock
require_expected_control_release
require_cmd base64

check_only=false
case ${1:-} in
  '') ;;
  --check) check_only=true ;;
  *) die "usage: $0 [--check]" ;;
esac

metadata_dir=$(mktemp -d /tmp/echo-analytics-source-columns.XXXXXX)
metadata_sql=$metadata_dir/all.sql
metadata_encoded=$metadata_dir/encoded.tsv
trap 'rm -rf -- "$metadata_dir"' EXIT

view_count=$(clickhouse_admin_http \
  "SELECT count() FROM system.tables WHERE database = '$CLICKHOUSE_CURRENT_DB' AND engine = 'View'")
[[ "$view_count" =~ ^[0-9]+$ ]] || die "ClickHouse returned an invalid view count"
((view_count > 0)) || die "no current-state ClickHouse views exist"
clickhouse_password_b64=$(printf '%s' "$CLICKHOUSE_GATEWAY_PASSWORD" | base64 -w 0)
fi

load_gateway_source_metadata() {
  # Generate literals on the source server so unusual column names remain safe.
  # The publication is the source of truth for the tables exposed by the mirror.
  source_psql \
    -v ON_ERROR_STOP=1 \
    -v publication="$SOURCE_PUBLICATION" \
    -Atq >"$metadata_encoded" <<'SQL'
WITH source_columns AS (
  SELECT n.nspname AS source_schema,
         c.relname AS source_table,
         CASE
           WHEN n.nspname = 'public' THEN c.relname
           ELSE n.nspname || '__' || c.relname
         END AS target_table,
         a.attname AS column_name,
         a.attnum AS ordinal_position,
         CASE a.atttypid
           WHEN 'pg_catalog.json'::pg_catalog.regtype THEN 'json'
           WHEN 'pg_catalog.jsonb'::pg_catalog.regtype THEN 'jsonb'
           WHEN 'pg_catalog.bytea'::pg_catalog.regtype THEN 'bytea'
           WHEN 'pg_catalog.tsvector'::pg_catalog.regtype THEN 'tsvector'
           WHEN 'pg_catalog.timestamp'::pg_catalog.regtype THEN 'timestamp'
           ELSE NULL
         END AS compatibility_type
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
)
SELECT target_table || E'\t' || replace(encode(convert_to(pg_catalog.format(
  'INSERT INTO source_column_metadata '
  '(source_schema, source_table, target_table, column_name, ordinal_position, compatibility_type) '
  'VALUES (%L, %L, %L, %L, %s, %L);',
  source_schema, source_table, target_table, column_name,
  ordinal_position, compatibility_type
), 'UTF8'), 'base64'), E'\n', '')
FROM source_columns
ORDER BY source_schema, source_table, ordinal_position;
SQL

  [[ -s "$metadata_encoded" ]] \
    || die "source publication has no column metadata: $SOURCE_PUBLICATION"
  while IFS=$'\t' read -r target encoded; do
    validate_identifier target_table "$target"
    statement=$(printf '%s' "$encoded" | base64 -d)
    printf '%s\n' "$statement" >>"$metadata_sql"
    printf '%s\n' "$statement" >>"$metadata_dir/$target.sql"
  done <"$metadata_encoded"
}

if [[ ${ECHO_GATEWAY_TEST_MODE:-false} != true ]]; then
  load_gateway_source_metadata
fi

emit_gateway_metadata_table() {
  cat <<'SQL'
CREATE TEMP TABLE source_column_metadata (
  source_schema text NOT NULL,
  source_table text NOT NULL,
  target_table text NOT NULL,
  column_name text NOT NULL,
  ordinal_position integer NOT NULL,
  compatibility_type text CHECK (
    compatibility_type IN ('json', 'jsonb', 'bytea', 'tsvector', 'timestamp')
  )
);
SQL
  cat "$1"
}

emit_gateway_select_list_function() {
  cat <<'SQL'
CREATE FUNCTION pg_temp.gateway_select_list(target text)
RETURNS text LANGUAGE sql STABLE AS $function$
  SELECT string_agg(
    CASE
      WHEN compatibility_type IS NULL
        OR compatibility_type IN ('bytea', 'timestamp')
        THEN format('foreign_row.%I', column_name)
      WHEN compatibility_type = 'json'
        THEN format(
          'pg_catalog.json_in(foreign_row.%1$I::pg_catalog.cstring) AS %1$I',
          column_name
        )
      WHEN compatibility_type = 'jsonb'
        THEN format(
          'pg_catalog.jsonb_in(foreign_row.%1$I::pg_catalog.cstring) AS %1$I',
          column_name
        )
      WHEN compatibility_type = 'tsvector'
        THEN format(
          'pg_catalog.tsvectorin(foreign_row.%1$I::pg_catalog.cstring) AS %1$I',
          column_name
        )
    END,
    ', ' ORDER BY ordinal_position
  )
  FROM source_column_metadata
  WHERE target_table = target;
$function$;
SQL
}

emit_gateway_grants_function() {
  cat <<'SQL'
CREATE FUNCTION pg_temp.gateway_set_view_grants(view_oid regclass, gateway_role text)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE
  view_schema text;
  view_name text;
  grantee_name text;
BEGIN
  SELECT namespace.nspname, relation.relname
  INTO view_schema, view_name
  FROM pg_class relation
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE relation.oid = view_oid;

  FOR grantee_name IN
    SELECT DISTINCT CASE
      WHEN acl.grantee = 0 THEN 'PUBLIC'
      ELSE format('%I', role.rolname)
    END
    FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(COALESCE(
      relation.relacl, acldefault('r', relation.relowner)
    )) acl
    LEFT JOIN pg_roles role ON role.oid = acl.grantee
    WHERE relation.oid = view_oid
      AND acl.grantee <> relation.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM %s',
                   view_schema, view_name, grantee_name);
  END LOOP;

  EXECUTE format('GRANT SELECT ON TABLE %I.%I TO %I',
                 view_schema, view_name, gateway_role);
END
$function$;
SQL
}

gateway_server_matches() {
  {
    printf '\\set clickhouse_password_b64 %s\n' "$clickhouse_password_b64"
    cat <<'SQL'
WITH gateway_server AS (
  SELECT server.oid,
         (SELECT jsonb_object_agg(option_name, option_value)
          FROM pg_options_to_table(server.srvoptions)) AS options
  FROM pg_foreign_server server
  JOIN pg_foreign_data_wrapper wrapper ON wrapper.oid = server.srvfdw
  WHERE server.srvname = 'echo_clickhouse'
    AND wrapper.fdwname = 'clickhouse_fdw'
), expected_options AS (
  SELECT jsonb_build_object(
    'driver', 'binary', 'host', '127.0.0.1',
    'port', :'clickhouse_port', 'dbname', :'clickhouse_db', 'secure', 'off'
  ) AS server_options,
  jsonb_build_object(
    'user', :'clickhouse_user',
    'password', convert_from(decode(:'clickhouse_password_b64', 'base64'), 'UTF8')
  ) AS mapping_options
)
SELECT EXISTS (
  SELECT 1
  FROM gateway_server server
  CROSS JOIN expected_options expected
  WHERE server.options = expected.server_options
    AND EXISTS (
      SELECT 1 FROM pg_namespace
      WHERE nspname = 'echo_clickhouse_foreign'
    )
    AND has_server_privilege(:'gateway_user', server.oid, 'USAGE')
    AND NOT EXISTS (
      SELECT 1
      FROM (VALUES (:'gateway_user'), (current_user)) AS roles(role_name)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_user_mapping mapping
        JOIN pg_roles role ON role.oid = mapping.umuser
        WHERE mapping.umserver = server.oid
          AND role.rolname = roles.role_name
          AND (SELECT jsonb_object_agg(option_name, option_value)
               FROM pg_options_to_table(mapping.umoptions))
              = expected.mapping_options
      )
    )
);
SQL
  } | postgres_psql --dbname "$GATEWAY_DB" -Atq \
    -v ON_ERROR_STOP=1 \
    -v gateway_user="$GATEWAY_USER" \
    -v clickhouse_user="$CLICKHOUSE_GATEWAY_USER" \
    -v clickhouse_db="$CLICKHOUSE_CURRENT_DB" \
    -v clickhouse_port="${CLICKHOUSE_NATIVE_PORT:-9000}"
}

gateway_refresh_plan() {
  {
    cat <<'SQL'
BEGIN;
SQL
    print_analytics_schema_reconcile_lock_sql
    cat <<'SQL'
SET LOCAL client_min_messages = warning;
SET LOCAL lock_timeout = '2s';
SQL
    emit_gateway_metadata_table "$metadata_sql"
    emit_gateway_select_list_function
    emit_gateway_grants_function
    cat <<'SQL'
CREATE TEMP TABLE gateway_refresh_config (
  expected_count integer NOT NULL,
  gateway_user text NOT NULL
);
INSERT INTO gateway_refresh_config VALUES (:'expected_count', :'gateway_user');
CREATE SCHEMA echo_clickhouse_refresh_expected;
SELECT format(
  'IMPORT FOREIGN SCHEMA %I FROM SERVER echo_clickhouse INTO echo_clickhouse_refresh_expected',
  :'clickhouse_db'
) \gexec
SELECT format(
  'ALTER FOREIGN TABLE echo_clickhouse_refresh_expected.%I ALTER COLUMN %I TYPE pg_catalog.bytea',
  target_table, column_name
)
FROM source_column_metadata
WHERE compatibility_type = 'bytea'
ORDER BY target_table, ordinal_position
\gexec
SELECT format(
  'ALTER FOREIGN TABLE echo_clickhouse_refresh_expected.%I ALTER COLUMN %I TYPE pg_catalog.timestamp',
  target_table, column_name
)
FROM source_column_metadata
WHERE compatibility_type = 'timestamp'
ORDER BY target_table, ordinal_position
\gexec

CREATE TEMP VIEW gateway_foreign_catalog AS
SELECT namespace.nspname AS schema_name,
       relation.relname AS table_name,
       jsonb_build_object(
         'server', server.srvname,
         'options', COALESCE(
           (SELECT jsonb_agg(option ORDER BY option)
            FROM unnest(foreign_table.ftoptions) option),
           '[]'::jsonb
         ),
         'columns', COALESCE(
           (SELECT jsonb_agg(
             jsonb_build_array(
               attribute.attname, attribute.atttypid,
               attribute.atttypmod, attribute.attnotnull,
               attribute.attcollation, attribute.attfdwoptions
             ) ORDER BY attribute.attnum
           )
           FROM pg_attribute attribute
           WHERE attribute.attrelid = relation.oid
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped),
           '[]'::jsonb
         )
       ) AS signature
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
JOIN pg_foreign_table foreign_table ON foreign_table.ftrelid = relation.oid
JOIN pg_foreign_server server ON server.oid = foreign_table.ftserver
WHERE namespace.nspname IN (
  'echo_clickhouse_refresh_expected', 'echo_clickhouse_foreign'
);

DO $do$
DECLARE
  expected_tables integer;
BEGIN
  IF EXISTS (
    SELECT target_table
    FROM source_column_metadata
    GROUP BY target_table
    HAVING count(DISTINCT (source_schema, source_table)) <> 1
  ) THEN
    RAISE EXCEPTION 'source table names collide after PeerDB target mapping';
  END IF;
  SELECT expected_count INTO expected_tables FROM gateway_refresh_config;
  IF (SELECT count(DISTINCT target_table) FROM source_column_metadata)
       <> expected_tables
    OR (SELECT count(*) FROM gateway_foreign_catalog
        WHERE schema_name = 'echo_clickhouse_refresh_expected')
       <> expected_tables
  THEN
    RAISE EXCEPTION 'source publication and ClickHouse view counts differ';
  END IF;
  IF EXISTS (
    (SELECT target_table, column_name FROM source_column_metadata
     EXCEPT
     SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'echo_clickhouse_refresh_expected')
    UNION ALL
    (SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'echo_clickhouse_refresh_expected'
     EXCEPT
     SELECT target_table, column_name FROM source_column_metadata)
  ) THEN
    RAISE EXCEPTION 'source and imported ClickHouse columns differ';
  END IF;
END
$do$;

CREATE TEMP TABLE gateway_refresh_plan (
  table_name text NOT NULL,
  action text NOT NULL CHECK (action IN ('replace', 'drop', 'grant_schema')),
  PRIMARY KEY (action, table_name)
);
INSERT INTO gateway_refresh_plan (table_name, action)
SELECT 'public', 'grant_schema'
WHERE NOT has_schema_privilege(:'gateway_user', 'public', 'USAGE');
INSERT INTO gateway_refresh_plan (table_name, action)
SELECT expected.table_name, 'replace'
FROM gateway_foreign_catalog expected
LEFT JOIN gateway_foreign_catalog actual
  ON actual.schema_name = 'echo_clickhouse_foreign'
 AND actual.table_name = expected.table_name
WHERE expected.schema_name = 'echo_clickhouse_refresh_expected'
  AND expected.signature IS DISTINCT FROM actual.signature;
INSERT INTO gateway_refresh_plan (table_name, action)
SELECT actual.table_name, 'drop'
FROM gateway_foreign_catalog actual
LEFT JOIN gateway_foreign_catalog expected
  ON expected.schema_name = 'echo_clickhouse_refresh_expected'
 AND expected.table_name = actual.table_name
WHERE actual.schema_name = 'echo_clickhouse_foreign'
  AND expected.table_name IS NULL;

DO $do$
DECLARE
  target record;
  select_list text;
  gateway_role text;
  expected_view_name text;
BEGIN
  SELECT gateway_user INTO gateway_role FROM gateway_refresh_config;
  FOR target IN
    SELECT expected.table_name
    FROM gateway_foreign_catalog expected
    WHERE expected.schema_name = 'echo_clickhouse_refresh_expected'
      AND NOT EXISTS (
        SELECT 1 FROM gateway_refresh_plan plan
        WHERE plan.table_name = expected.table_name
          AND plan.action = 'replace'
      )
  LOOP
    select_list := pg_temp.gateway_select_list(target.table_name);
    IF select_list IS NULL THEN
      RAISE EXCEPTION 'no source columns found for %', target.table_name;
    END IF;
    expected_view_name := 'echo_expected_' || md5(target.table_name);
    EXECUTE format(
      'CREATE TEMP VIEW %I AS SELECT %s FROM echo_clickhouse_foreign.%I AS foreign_row',
      expected_view_name, select_list, target.table_name
    );
    PERFORM pg_temp.gateway_set_view_grants(
      format('pg_temp.%I', expected_view_name)::regclass, gateway_role
    );
  END LOOP;
END
$do$;

CREATE TEMP VIEW gateway_view_catalog AS
SELECT namespace.nspname AS schema_name,
       relation.relname AS view_name,
       pg_get_viewdef(relation.oid, false) AS definition,
       relation.relowner AS owner,
       COALESCE(
         (SELECT jsonb_agg(
           jsonb_build_array(acl.grantor, acl.grantee,
                             acl.privilege_type, acl.is_grantable)
           ORDER BY acl.grantor, acl.grantee,
                    acl.privilege_type, acl.is_grantable
         )
         FROM aclexplode(COALESCE(
           relation.relacl, acldefault('r', relation.relowner)
         )) acl),
         '[]'::jsonb
       ) AS grants,
       COALESCE(
         (SELECT jsonb_agg(option ORDER BY option)
          FROM unnest(relation.reloptions) option),
         '[]'::jsonb
       ) AS security_options,
       COALESCE(
         (SELECT jsonb_agg(
           jsonb_build_array(
             attribute.attname, attribute.atttypid,
             attribute.atttypmod, attribute.attnotnull,
             COALESCE(
               (SELECT jsonb_agg(
                 jsonb_build_array(acl.grantor, acl.grantee,
                                   acl.privilege_type, acl.is_grantable)
                 ORDER BY acl.grantor, acl.grantee,
                          acl.privilege_type, acl.is_grantable
               )
               FROM aclexplode(attribute.attacl) acl),
               '[]'::jsonb
             )
           ) ORDER BY attribute.attnum
         )
         FROM pg_attribute attribute
         WHERE attribute.attrelid = relation.oid
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped),
         '[]'::jsonb
       ) AS columns
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind = 'v'
  AND (namespace.nspname = 'public'
       OR namespace.oid = pg_my_temp_schema());

INSERT INTO gateway_refresh_plan (table_name, action)
SELECT expected.table_name, 'replace'
FROM gateway_foreign_catalog expected
LEFT JOIN gateway_view_catalog public_view
  ON public_view.schema_name = 'public'
 AND public_view.view_name = expected.table_name
LEFT JOIN gateway_view_catalog expected_view
  ON expected_view.view_name = 'echo_expected_' || md5(expected.table_name)
 AND expected_view.schema_name = (
   SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()
 )
WHERE expected.schema_name = 'echo_clickhouse_refresh_expected'
  AND NOT EXISTS (
    SELECT 1 FROM gateway_refresh_plan plan
    WHERE plan.table_name = expected.table_name
      AND plan.action = 'replace'
  )
  AND (public_view.definition IS DISTINCT FROM expected_view.definition
       OR public_view.columns IS DISTINCT FROM expected_view.columns
       OR public_view.owner IS DISTINCT FROM expected_view.owner
       OR public_view.grants IS DISTINCT FROM expected_view.grants
       OR public_view.security_options IS DISTINCT FROM expected_view.security_options);

DROP SCHEMA echo_clickhouse_refresh_expected CASCADE;
COMMIT;
SELECT action || E'\t' || table_name
FROM gateway_refresh_plan
ORDER BY CASE action WHEN 'grant_schema' THEN 0 ELSE 1 END, table_name;
SQL
  } | postgres_psql --dbname "$GATEWAY_DB" -Atq \
    -v ON_ERROR_STOP=1 \
    -v schema_reconcile_lock_name="$ANALYTICS_SCHEMA_RECONCILE_LOCK_NAME" \
    -v clickhouse_db="$CLICKHOUSE_CURRENT_DB" \
    -v gateway_user="$GATEWAY_USER" \
    -v expected_count="$view_count"
}

refresh_gateway_table() {
  local action=$1 target=$2
  {
    cat <<'SQL'
BEGIN;
SQL
    print_analytics_schema_reconcile_lock_sql
    cat <<'SQL'
SET LOCAL client_min_messages = warning;
SET LOCAL lock_timeout = '2s';
CREATE TEMP TABLE gateway_target_config AS SELECT :'target_table'::text AS table_name;
SELECT format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE NOWAIT', :'target_table')
WHERE to_regclass(format('public.%I', :'target_table')) IS NOT NULL
\gexec
DO $do$
DECLARE
  public_relation oid;
  public_kind "char";
  foreign_relation oid;
  target_name text;
BEGIN
  SELECT table_name INTO target_name FROM gateway_target_config;
  SELECT relation.oid, relation.relkind
  INTO public_relation, public_kind
  FROM pg_class relation
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname = target_name;
  SELECT relation.oid INTO foreign_relation
  FROM pg_class relation
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'echo_clickhouse_foreign'
    AND relation.relname = target_name
    AND relation.relkind = 'f';
  IF public_relation IS NOT NULL AND (
    public_kind <> 'v' OR foreign_relation IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_rewrite rewrite
      JOIN pg_depend dependency
        ON dependency.classid = 'pg_rewrite'::regclass
       AND dependency.objid = rewrite.oid
      WHERE rewrite.ev_class = public_relation
        AND dependency.refobjid = foreign_relation
    )
  ) THEN
    RAISE EXCEPTION 'public.% is not a compatibility view for its foreign table',
      target_name;
  END IF;
END
$do$;
SELECT format('DROP VIEW IF EXISTS public.%I', :'target_table') \gexec
SELECT format(
  'DROP FOREIGN TABLE IF EXISTS echo_clickhouse_foreign.%I', :'target_table'
) \gexec
SQL
    if [[ "$action" == replace ]]; then
      emit_gateway_metadata_table "$metadata_dir/$target.sql"
      emit_gateway_select_list_function
      emit_gateway_grants_function
      cat <<'SQL'
SELECT format(
  'IMPORT FOREIGN SCHEMA %I LIMIT TO (%I) FROM SERVER echo_clickhouse INTO echo_clickhouse_foreign',
  :'clickhouse_db', :'target_table'
) \gexec
SELECT format(
  'ALTER FOREIGN TABLE echo_clickhouse_foreign.%I ALTER COLUMN %I TYPE pg_catalog.bytea',
  target_table, column_name
)
FROM source_column_metadata
WHERE compatibility_type = 'bytea'
ORDER BY ordinal_position
\gexec
SELECT format(
  'ALTER FOREIGN TABLE echo_clickhouse_foreign.%I ALTER COLUMN %I TYPE pg_catalog.timestamp',
  target_table, column_name
)
FROM source_column_metadata
WHERE compatibility_type = 'timestamp'
ORDER BY ordinal_position
\gexec
DO $do$
DECLARE
  target_name text;
BEGIN
  SELECT table_name INTO target_name FROM gateway_target_config;
  IF NOT EXISTS (SELECT 1 FROM source_column_metadata) OR EXISTS (
    (SELECT column_name FROM source_column_metadata
     EXCEPT
     SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'echo_clickhouse_foreign'
       AND table_name = target_name)
    UNION ALL
    (SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'echo_clickhouse_foreign'
       AND table_name = target_name
     EXCEPT
     SELECT column_name FROM source_column_metadata)
  ) THEN
    RAISE EXCEPTION 'imported columns differ from source for %', target_name;
  END IF;
END
$do$;
SELECT format(
  'CREATE VIEW public.%1$I AS SELECT %2$s FROM echo_clickhouse_foreign.%1$I AS foreign_row',
  :'target_table', pg_temp.gateway_select_list(:'target_table')
) \gexec
SELECT pg_temp.gateway_set_view_grants(
  format('public.%I', :'target_table')::regclass, :'gateway_user'
) AS grants_reconciled \gset
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'gateway_user') \gexec
SQL
    fi
    cat <<'SQL'
COMMIT;
SQL
  } | postgres_psql --dbname "$GATEWAY_DB" -q \
    -v ON_ERROR_STOP=1 \
    -v schema_reconcile_lock_name="$ANALYTICS_SCHEMA_RECONCILE_LOCK_NAME" \
    -v target_table="$target" \
    -v gateway_user="$GATEWAY_USER" \
    -v clickhouse_db="$CLICKHOUSE_CURRENT_DB"
}

refresh_gateway_public_schema_grant() {
  {
    cat <<'SQL'
BEGIN;
SQL
    print_analytics_schema_reconcile_lock_sql
    cat <<'SQL'
SET LOCAL lock_timeout = '2s';
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'gateway_user') \gexec
COMMIT;
SQL
  } | postgres_psql --dbname "$GATEWAY_DB" -q \
    -v ON_ERROR_STOP=1 \
    -v schema_reconcile_lock_name="$ANALYTICS_SCHEMA_RECONCILE_LOCK_NAME" \
    -v gateway_user="$GATEWAY_USER"
}

refresh_gateway_incremental() {
  local plan action target refreshed=0
  plan=$(gateway_refresh_plan)
  if $check_only; then
    [[ -z "$plan" ]] || die "gateway compatibility drift detected: $plan"
    log "Gateway compatibility views match source and ClickHouse definitions"
    return 0
  fi

  while IFS=$'\t' read -r action target; do
    [[ -n "$action" ]] || continue
    if [[ "$action" == grant_schema ]]; then
      [[ "$target" == public ]] || die "invalid gateway schema grant: $target"
      retry_source_reconciliation_step \
        "Gateway public schema grant" refresh_gateway_public_schema_grant
      continue
    fi
    [[ "$action" == replace || "$action" == drop ]] \
      || die "invalid gateway refresh action: $action"
    validate_identifier gateway_table "$target"
    if [[ "$action" == replace ]]; then
      require_file "$metadata_dir/$target.sql"
    fi
    SOURCE_RECONCILE_RETRY_ATTEMPTS=${ANALYTICS_GATEWAY_TABLE_RETRY_ATTEMPTS:-30} \
    SOURCE_RECONCILE_RETRY_DELAY_SECONDS=${ANALYTICS_GATEWAY_TABLE_RETRY_DELAY_SECONDS:-2} \
      retry_source_reconciliation_step \
        "Gateway $action for $target" refresh_gateway_table "$action" "$target"
    refreshed=$((refreshed + 1))
  done <<<"$plan"

  if [[ -n "$plan" ]]; then
    [[ -z $(gateway_refresh_plan) ]] \
      || die "gateway compatibility drift remains after targeted refresh"
  fi
  "$SCRIPT_DIR/reconcile-derived-schema.sh"
  log "Reconciled $refreshed gateway compatibility views"
}

if [[ ${ECHO_GATEWAY_TEST_MODE:-false} != true ]]; then
server_matches=$(gateway_server_matches)
[[ "$server_matches" == t || "$server_matches" == f ]] \
  || die "could not verify the gateway foreign server configuration"
if [[ "$server_matches" == t ]]; then
  refresh_gateway_incremental
  exit 0
fi
$check_only && die "gateway foreign server configuration differs from the deployed settings"
log "Gateway foreign server configuration changed; rebuilding gateway objects"

{
  printf '\\set clickhouse_password_b64 %s\n' "$clickhouse_password_b64"
  cat <<'SQL'
BEGIN;
SQL
  print_analytics_schema_reconcile_lock_sql
  cat <<'SQL'
SET LOCAL client_min_messages = warning;
CREATE TEMP TABLE source_column_metadata (
  source_schema text NOT NULL,
  source_table text NOT NULL,
  target_table text NOT NULL,
  column_name text NOT NULL,
  ordinal_position integer NOT NULL,
  compatibility_type text CHECK (
    compatibility_type IN (
      'json', 'jsonb', 'bytea', 'tsvector', 'timestamp'
    )
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

SELECT format(
  'ALTER FOREIGN TABLE echo_clickhouse_foreign.%I ALTER COLUMN %I TYPE pg_catalog.timestamp',
  metadata.target_table,
  metadata.column_name
)
FROM source_column_metadata metadata
WHERE metadata.compatibility_type = 'timestamp'
ORDER BY metadata.target_table, metadata.ordinal_position
\gexec

DO $do$
DECLARE
  foreign_table record;
  select_list text;
  column_difference text;
BEGIN
  IF (
    SELECT count(*)
    FROM information_schema.foreign_tables
    WHERE foreign_table_schema = 'echo_clickhouse_foreign'
  ) <> (SELECT expected_count FROM gateway_refresh_config) THEN
    RAISE EXCEPTION 'imported foreign-table count does not match ClickHouse view count';
  END IF;

  WITH imported_columns AS (
    SELECT foreign_relation.foreign_table_name AS target_table,
           column_info.column_name
    FROM information_schema.foreign_tables foreign_relation
    JOIN information_schema.columns column_info
      ON column_info.table_schema = foreign_relation.foreign_table_schema
     AND column_info.table_name = foreign_relation.foreign_table_name
    WHERE foreign_relation.foreign_table_schema = 'echo_clickhouse_foreign'
  ), differing_columns AS (
    SELECT 'source only' AS side, missing.* FROM (
      SELECT target_table, column_name FROM source_column_metadata
      EXCEPT
      SELECT target_table, column_name FROM imported_columns
    ) missing
    UNION ALL
    SELECT 'imported only' AS side, extra.* FROM (
      SELECT target_table, column_name FROM imported_columns
      EXCEPT
      SELECT target_table, column_name FROM source_column_metadata
    ) extra
  )
  SELECT string_agg(format('%s: %I.%I', side, target_table, column_name),
                    E'\n' ORDER BY side, target_table, column_name)
  INTO column_difference
  FROM differing_columns;
  IF column_difference IS NOT NULL THEN
    RAISE EXCEPTION 'source and imported ClickHouse columns do not match'
      USING DETAIL = column_difference;
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
          OR metadata.compatibility_type IN ('bytea', 'timestamp')
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
  -v schema_reconcile_lock_name="$ANALYTICS_SCHEMA_RECONCILE_LOCK_NAME" \
  -v expected_count="$view_count" \
  -v gateway_user="$GATEWAY_USER" \
  -v clickhouse_user="$CLICKHOUSE_GATEWAY_USER" \
  -v clickhouse_db="$CLICKHOUSE_CURRENT_DB" \
  -v clickhouse_port="${CLICKHOUSE_NATIVE_PORT:-9000}"

"$SCRIPT_DIR/reconcile-derived-schema.sh"

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
fi
