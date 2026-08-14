#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../bin/lib.sh
source "$TEST_DIR/../bin/lib.sh"

require_cmd psql
require_cmd sudo

test_database="echo_analytics_lock_test_$$"
[[ "$test_database" =~ ^[a-z_][a-z0-9_]*$ ]]

postgres_test_psql() {
  sudo -u postgres psql -X \
    --host /var/run/postgresql \
    -v ON_ERROR_STOP=1 \
    "$@"
}

cleanup() {
  postgres_test_psql --dbname postgres \
    -c "DROP DATABASE IF EXISTS \"$test_database\" WITH (FORCE)" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

postgres_test_psql --dbname postgres \
  -c "CREATE DATABASE \"$test_database\"" >/dev/null
postgres_test_psql --dbname "$test_database" <<'SQL' >/dev/null
CREATE SCHEMA lock_target;
CREATE TABLE public.lock_events (
  writer text NOT NULL,
  event text NOT NULL,
  occurred_at timestamptz NOT NULL
);
SQL

run_catalog_writer() {
  local writer=$1
  {
    cat <<'SQL'
BEGIN;
SQL
    print_analytics_schema_reconcile_lock_sql
    cat <<'SQL'
INSERT INTO public.lock_events VALUES (
  :'writer',
  'entered',
  clock_timestamp()
);
SELECT pg_sleep(0.5) AS catalog_write_delay_completed
\gset
REVOKE ALL ON SCHEMA lock_target FROM PUBLIC;
INSERT INTO public.lock_events VALUES (
  :'writer',
  'exited',
  clock_timestamp()
);
COMMIT;
SQL
  } | postgres_test_psql \
    --dbname "$test_database" \
    -q \
    -v schema_reconcile_lock_name="$ANALYTICS_SCHEMA_RECONCILE_LOCK_NAME" \
    -v writer="$writer"
}

run_catalog_writer first &
first_pid=$!
run_catalog_writer second &
second_pid=$!
wait "$first_pid"
wait "$second_pid"

overlap_count=$(postgres_test_psql \
  --dbname "$test_database" \
  -Atq <<'SQL'
WITH writer_windows AS (
  SELECT writer,
         min(occurred_at) AS entered_at,
         max(occurred_at) AS exited_at
  FROM public.lock_events
  GROUP BY writer
)
SELECT count(*)
FROM writer_windows first_writer
JOIN writer_windows second_writer
  ON first_writer.writer < second_writer.writer
 AND first_writer.entered_at < second_writer.exited_at
 AND second_writer.entered_at < first_writer.exited_at;
SQL
)
[[ "$overlap_count" == 0 ]]

for script in reconcile-derived-schema.sh refresh-gateway.sh; do
  grep -q 'print_analytics_schema_reconcile_lock_sql' \
    "$TEST_DIR/../bin/$script"
done

printf 'Analytics schema reconciliation lock tests passed\n'
