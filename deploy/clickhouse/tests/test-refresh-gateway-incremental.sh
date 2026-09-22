#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
cd /tmp
test_database="echo_gateway_incremental_test_$$"
test_role="echo_gateway_test_$$"
metadata_dir=$(mktemp -d /tmp/echo-gateway-incremental-test.XXXXXX)
cleanup() {
  sudo -u postgres psql -X --host /var/run/postgresql --dbname postgres \
    -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$test_database\" WITH (FORCE)" \
    >/dev/null 2>&1 || true
  sudo -u postgres psql -X --host /var/run/postgresql --dbname postgres \
    -v ON_ERROR_STOP=1 \
    -c "DROP ROLE IF EXISTS \"$test_role\"" \
    >/dev/null 2>&1 || true
  rm -rf -- "$metadata_dir"
}
trap cleanup EXIT

sudo -u postgres psql -X --host /var/run/postgresql --dbname postgres \
  -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$test_database\"" >/dev/null
sudo -u postgres psql -X --host /var/run/postgresql \
  --dbname "$test_database" -v ON_ERROR_STOP=1 <<SQL >/dev/null
CREATE EXTENSION postgres_fdw;
CREATE ROLE "$test_role";
CREATE FOREIGN DATA WRAPPER clickhouse_fdw
  HANDLER postgres_fdw_handler VALIDATOR postgres_fdw_validator;
CREATE SERVER echo_clickhouse FOREIGN DATA WRAPPER clickhouse_fdw
  OPTIONS (host '/var/run/postgresql', port '5432', dbname '$test_database');
CREATE USER MAPPING FOR CURRENT_USER SERVER echo_clickhouse
  OPTIONS (user 'postgres');
CREATE SCHEMA ch_current;
CREATE SCHEMA echo_clickhouse_foreign;
CREATE TABLE ch_current.echo_test (id bigint, payload text, data text);
CREATE TABLE public.echo_test (id bigint, payload text, data jsonb);
SET client_min_messages = error;
CREATE PUBLICATION echo_test_publication FOR TABLE public.echo_test;
SQL

export ECHO_GATEWAY_TEST_MODE=true
# shellcheck source=../bin/refresh-gateway.sh
source "$TEST_DIR/../bin/refresh-gateway.sh"
POSTGRESQL_MAJOR=$(sudo -u postgres psql -X --host /var/run/postgresql \
  --dbname "$test_database" -Atqc \
  "SELECT current_setting('server_version_num')::integer / 10000")
GATEWAY_DB=$test_database
GATEWAY_USER=$test_role
CLICKHOUSE_CURRENT_DB=ch_current
CLICKHOUSE_GATEWAY_USER=postgres
CLICKHOUSE_NATIVE_PORT=5432
clickhouse_password_b64=$(printf 'test-password' | base64 -w 0)
postgres_psql() {
  local argument
  for argument in "$@"; do
    if [[ "$argument" == *"$clickhouse_password_b64"* ]]; then
      printf 'gateway password appeared in PostgreSQL process arguments\n' >&2
      return 1
    fi
  done
  sudo -u postgres "/usr/lib/postgresql/$POSTGRESQL_MAJOR/bin/psql" -X \
    --host /var/run/postgresql "$@"
}
view_count=1
metadata_sql=$metadata_dir/all.sql
metadata_encoded=$metadata_dir/encoded.tsv
SOURCE_PUBLICATION=echo_test_publication
source_psql() {
  sudo -u postgres psql -X --host /var/run/postgresql \
    --dbname "$test_database" "$@"
}
assert_gateway_check_rejects_drift() {
  if (check_only=true; refresh_gateway_incremental) \
    >"$metadata_dir/check.log" 2>&1; then
    printf 'gateway check unexpectedly accepted drift\n' >&2
    exit 1
  fi
  grep -q 'gateway compatibility drift detected' "$metadata_dir/check.log"
}
load_gateway_source_metadata
[[ $(wc -l <"$metadata_sql") == 3 ]]
sudo -u postgres psql -X --host /var/run/postgresql \
  --dbname "$test_database" -v ON_ERROR_STOP=1 \
  -c 'DROP TABLE public.echo_test CASCADE' >/dev/null

[[ $(gateway_server_matches) == f ]]
[[ $(gateway_refresh_plan) == $'replace\techo_test' ]]
refresh_gateway_table replace echo_test
[[ -z $(gateway_refresh_plan) ]]
(check_only=true; refresh_gateway_incremental) >/dev/null
[[ $(postgres_psql --dbname "$test_database" -Atqc \
  "SELECT udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'echo_test' AND column_name = 'data'") == jsonb ]]

sudo -u postgres psql -X --host /var/run/postgresql \
  --dbname "$test_database" -v ON_ERROR_STOP=1 \
  -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC; REVOKE SELECT ON TABLE public.echo_test FROM \"$test_role\"" >/dev/null
[[ $(gateway_refresh_plan) == $'replace\techo_test' ]]
assert_gateway_check_rejects_drift
refresh_gateway_table replace echo_test
[[ -z $(gateway_refresh_plan) ]]

sudo -u postgres psql -X --host /var/run/postgresql \
  --dbname "$test_database" -v ON_ERROR_STOP=1 \
  -c "REVOKE ALL ON SCHEMA public FROM PUBLIC; REVOKE USAGE ON SCHEMA public FROM \"$test_role\"" >/dev/null
[[ $(gateway_refresh_plan) == $'grant_schema\tpublic' ]]
assert_gateway_check_rejects_drift
refresh_gateway_public_schema_grant
[[ -z $(gateway_refresh_plan) ]]

sudo -u postgres psql -X --host /var/run/postgresql \
  --dbname "$test_database" -v ON_ERROR_STOP=1 \
  -c 'GRANT SELECT ON TABLE public.echo_test TO PUBLIC' >/dev/null
[[ $(gateway_refresh_plan) == $'replace\techo_test' ]]
assert_gateway_check_rejects_drift
refresh_gateway_table replace echo_test
[[ -z $(gateway_refresh_plan) ]]

sudo -u postgres psql -X --host /var/run/postgresql \
  --dbname "$test_database" -v ON_ERROR_STOP=1 \
  -c 'GRANT SELECT (data) ON TABLE public.echo_test TO PUBLIC' >/dev/null
[[ $(gateway_refresh_plan) == $'replace\techo_test' ]]
assert_gateway_check_rejects_drift
refresh_gateway_table replace echo_test
[[ -z $(gateway_refresh_plan) ]]

sudo -u postgres psql -X --host /var/run/postgresql \
  --dbname "$test_database" -v ON_ERROR_STOP=1 \
  -c 'ALTER VIEW public.echo_test SET (security_barrier = true)' >/dev/null
[[ $(gateway_refresh_plan) == $'replace\techo_test' ]]
assert_gateway_check_rejects_drift
refresh_gateway_table replace echo_test
[[ -z $(gateway_refresh_plan) ]]

sudo -u postgres psql -X --host /var/run/postgresql \
  --dbname "$test_database" -v ON_ERROR_STOP=1 \
  -c 'BEGIN; LOCK TABLE public.echo_test IN ACCESS SHARE MODE; SELECT pg_sleep(2); COMMIT' \
  >/dev/null &
locker_pid=$!
for ((attempt = 0; attempt < 20; attempt++)); do
  held_locks=$(postgres_psql --dbname "$test_database" -Atqc \
    "SELECT count(*) FROM pg_locks WHERE relation = 'public.echo_test'::regclass AND mode = 'AccessShareLock' AND granted")
  ((held_locks > 0)) && break
  sleep 0.05
done
((held_locks > 0))
if lock_output=$(refresh_gateway_table replace echo_test 2>&1); then
  printf 'gateway replacement unexpectedly acquired a busy view lock\n' >&2
  exit 1
fi
[[ "$lock_output" == *'could not obtain lock on relation'* ]]
source_reconciliation_failure_is_transient "$lock_output"
wait "$locker_pid"
[[ -z $(gateway_refresh_plan) ]]

sudo -u postgres psql -X --host /var/run/postgresql \
  --dbname "$test_database" -v ON_ERROR_STOP=1 \
  -c 'ALTER TABLE ch_current.echo_test ADD COLUMN note text' >/dev/null
printf '%s\n' \
  "INSERT INTO source_column_metadata VALUES ('public', 'echo_test', 'echo_test', 'note', 3, NULL);" \
  >>"$metadata_sql"
cp "$metadata_sql" "$metadata_dir/echo_test.sql"
[[ $(gateway_refresh_plan) == $'replace\techo_test' ]]
refresh_gateway_table replace echo_test
[[ -z $(gateway_refresh_plan) ]]

sudo -u postgres psql -X --host /var/run/postgresql \
  --dbname "$test_database" -v ON_ERROR_STOP=1 \
  -c "CREATE OR REPLACE VIEW public.echo_test AS SELECT id, upper(payload) AS payload, pg_catalog.jsonb_in(data::pg_catalog.cstring) AS data, note FROM echo_clickhouse_foreign.echo_test" >/dev/null
[[ $(gateway_refresh_plan) == $'replace\techo_test' ]]
refresh_gateway_table replace echo_test
[[ -z $(gateway_refresh_plan) ]]

sudo -u postgres psql -X --host /var/run/postgresql \
  --dbname "$test_database" -v ON_ERROR_STOP=1 <<SQL >/dev/null
SET client_min_messages = warning;
DROP SERVER echo_clickhouse CASCADE;
DROP FOREIGN DATA WRAPPER clickhouse_fdw;
CREATE FOREIGN DATA WRAPPER clickhouse_fdw HANDLER postgres_fdw_handler;
CREATE SERVER echo_clickhouse FOREIGN DATA WRAPPER clickhouse_fdw
  OPTIONS (driver 'binary', host '127.0.0.1', port '5432',
           dbname 'ch_current', secure 'off');
CREATE USER MAPPING FOR CURRENT_USER SERVER echo_clickhouse
  OPTIONS (user 'postgres', password 'test-password');
CREATE USER MAPPING FOR "$test_role" SERVER echo_clickhouse
  OPTIONS (user 'postgres', password 'test-password');
GRANT USAGE ON FOREIGN SERVER echo_clickhouse TO "$test_role";
SQL
[[ $(gateway_server_matches) == t ]]

printf 'Incremental gateway refresh tests passed\n'
