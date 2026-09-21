#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
COMMAND=$TEST_DIR/../bin/source-repair-role.sh
case_dir=$(mktemp -d /tmp/echo-source-role-test.XXXXXX)
test_database="echo_peerdb_role_test_$$"
test_role="${test_database}_user"

postgres_test_psql() {
  sudo -u postgres psql -X --host /var/run/postgresql \
    -v ON_ERROR_STOP=1 "$@"
}

cleanup() {
  postgres_test_psql --dbname postgres \
    -c "DROP DATABASE IF EXISTS \"$test_database\" WITH (FORCE)" \
    -c "DROP ROLE IF EXISTS \"$test_role\"" >/dev/null 2>&1 || true
  rm -rf -- "$case_dir"
}
trap cleanup EXIT

postgres_test_psql --dbname postgres \
  -c "CREATE DATABASE \"$test_database\"" \
  -c "CREATE ROLE \"$test_role\" NOLOGIN NOREPLICATION NOBYPASSRLS PASSWORD 'test-peerdb-role'" \
  >/dev/null
postgres_test_psql --dbname "$test_database" -v test_role="$test_role" \
  -v test_database="$test_database" <<'SQL' >/dev/null
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'test_database') \gexec
SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'test_role', '7s') \gexec
CREATE TABLE original_role AS
SELECT credentials.rolpassword, replication_role.rolconfig,
       replication_role.rolsuper, replication_role.rolcreatedb, replication_role.rolcreaterole
FROM pg_authid credentials JOIN pg_roles replication_role USING (oid)
WHERE replication_role.rolname = :'test_role';
SQL

cat >"$case_dir/source.env" <<EOF
SOURCE_DB=$test_database
SOURCE_USER=$test_role
SOURCE_PUBLICATION=test_publication
SOURCE_PASSWORD=test-peerdb-role
SOURCE_PG_MAJOR=18
SOURCE_PG_CLUSTER=main
SOURCE_LISTEN_ADDRESS=127.0.0.1
ANALYTICS_ADDRESS=127.0.0.1/32
SOURCE_MAX_SLOT_WAL_KEEP_SIZE=1GB
EOF

run_repair() {
  ECHO_PEERDB_SOURCE_CONFIG_FILE="$case_dir/source.env" \
  ECHO_PEERDB_RECONCILE_STATE_DIR="$case_dir/state" \
    bash "$COMMAND" "$@"
}

expect_failure() {
  if run_repair "$@" >"$case_dir/output" 2>&1; then
    printf 'role command unexpectedly succeeded: %s\n' "$*" >&2
    exit 1
  fi
}

expect_failure
expect_failure --invalid
expect_failure --check
grep -q 'LOGIN, REPLICATION, BYPASSRLS, CONNECT' "$case_dir/output"
grep -q 'source-repair-role.sh --yes explicitly' "$case_dir/output"
[[ $(postgres_test_psql --dbname "$test_database" -Atq \
  -c "SELECT rolcanlogin FROM pg_roles WHERE rolname = '$test_role'") == f ]]

run_repair --yes
run_repair --yes
run_repair --check
[[ $(postgres_test_psql --dbname "$test_database" -Atq \
  -v test_role="$test_role" <<'SQL'
SELECT replication_role.rolcanlogin AND replication_role.rolreplication AND replication_role.rolbypassrls
  AND has_database_privilege(oid, current_database(), 'CONNECT')
  AND credentials.rolpassword = original_role.rolpassword
  AND replication_role.rolconfig = original_role.rolconfig
  AND replication_role.rolsuper = original_role.rolsuper
  AND replication_role.rolcreatedb = original_role.rolcreatedb
  AND replication_role.rolcreaterole = original_role.rolcreaterole
FROM pg_authid credentials JOIN pg_roles replication_role USING (oid)
CROSS JOIN original_role
WHERE replication_role.rolname = :'test_role';
SQL
) == t ]]

for attribute in LOGIN REPLICATION BYPASSRLS; do
  postgres_test_psql --dbname postgres \
    -c "ALTER ROLE \"$test_role\" NO$attribute" >/dev/null
  expect_failure --check
  grep -q "lacks $attribute;" "$case_dir/output"
  run_repair --yes
done

postgres_test_psql --dbname "$test_database" \
  -c "REVOKE CONNECT ON DATABASE \"$test_database\" FROM \"$test_role\"" >/dev/null
expect_failure --check
grep -q 'lacks CONNECT;' "$case_dir/output"
run_repair --yes

postgres_test_psql --dbname "$test_database" \
  -c "DROP OWNED BY \"$test_role\"" \
  -c "DROP ROLE \"$test_role\"" >/dev/null
expect_failure --check
grep -q 'does not exist; run source-configure.sh first' "$case_dir/output"
expect_failure --yes
[[ $(postgres_test_psql --dbname postgres -Atq \
  -c "SELECT count(*) FROM pg_roles WHERE rolname = '$test_role'") == 0 ]]

printf 'Source replication role authorization tests passed\n'
