#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
case_dir=$(mktemp -d /tmp/echo-analytics-health-timeout-test.XXXXXX)
cleanup() {
  rm -rf -- "$case_dir"
}
trap cleanup EXIT

mkdir -p "$case_dir/bin" "$case_dir/path"
cp "$TEST_DIR/../bin/check-analytics-health.sh" "$case_dir/bin/"

cat >"$case_dir/bin/lib.sh" <<'MOCK'
load_analytics_config() {
  GATEWAY_DB=test_gateway
  MIRROR_NAME=test_mirror
}
validate_runtime_identifiers() { :; }
validate_identifier() { :; }
require_expected_control_release() { :; }
log() { :; }
die() {
  printf '%s\n' "$1" >&2
  exit 1
}
catalog_psql() {
  cat >/dev/null
  printf '1\n'
}
source_psql() {
  local sql
  sql=$(cat)
  if [[ "$*" == *pg_current_wal_lsn* ]]; then
    printf '1/20\n'
  elif grep -q pg_replication_slots <<<"$sql"; then
    printf 'reserved|1/10\n'
  else
    printf '2026-09-15 10:00:00+00\n'
  fi
}
gateway_psql() {
  cat >/dev/null
}
postgres_psql() {
  cat >"$ECHO_TEST_HEALTH_SQL"
}
MOCK

cat >"$case_dir/path/systemctl" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x "$case_dir/path/systemctl"

health_sql=$case_dir/health.sql
error_log=$case_dir/error.log
if PATH="$case_dir/path:$PATH" \
  ECHO_TEST_HEALTH_SQL="$health_sql" \
  ANALYTICS_HEALTH_PROBE_TIMEOUT_SECONDS=1 \
  bash "$case_dir/bin/check-analytics-health.sh" 2>"$error_log"
then
  printf 'delayed analytics heartbeat unexpectedly passed health check\n' >&2
  exit 1
fi

grep -q '^UPDATE public.echo_analytics_health' "$health_sql"
if grep -Eq 'checked_at|healthy' "$health_sql"; then
  printf 'probe delay unexpectedly replaced the last health decision\n' >&2
  exit 1
fi
grep -q 'source heartbeat was not visible through ClickHouse within 1s' \
  "$error_log"

printf 'Analytics health probe timeout tests passed\n'
