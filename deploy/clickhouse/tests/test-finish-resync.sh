#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
COMMAND=$TEST_DIR/../bin/finish-resync.sh
case_dir=$(mktemp -d /tmp/echo-finish-resync-test.XXXXXX)
cleanup() {
  rm -rf -- "$case_dir"
}
trap cleanup EXIT

mkdir -p "$case_dir/bin"
cp "$COMMAND" "$case_dir/bin/finish-resync.sh"
chmod +x "$case_dir/bin/finish-resync.sh"
cat >"$case_dir/bin/lib.sh" <<'LIB'
load_analytics_config() { :; }
validate_runtime_identifiers() { :; }
acquire_analytics_reconcile_lock() { :; }
require_expected_control_release() { :; }
delegate_paired_analytics_operation_if_source() { :; }
catalog_psql() { printf '1\n'; }
log() { :; }
die() { printf '%s\n' "$*" >&2; exit 1; }
MIRROR_NAME=echo_postgres_to_clickhouse
LIB

cat >"$case_dir/bin/refresh-current-views.sh" <<'MOCK'
#!/usr/bin/env bash
printf 'current\n' >>"$ECHO_TEST_OPERATIONS"
MOCK
cat >"$case_dir/bin/refresh-gateway.sh" <<'MOCK'
#!/usr/bin/env bash
printf 'gateway\n' >>"$ECHO_TEST_OPERATIONS"
MOCK
cat >"$case_dir/bin/reconcile-if-needed.sh" <<'MOCK'
#!/usr/bin/env bash
printf 'reconcile\n' >>"$ECHO_TEST_OPERATIONS"
touch "$ECHO_TEST_RECONCILE_STATE"
MOCK
cat >"$case_dir/bin/check-analytics-health.sh" <<'MOCK'
#!/usr/bin/env bash
test -f "$ECHO_TEST_RECONCILE_STATE"
printf 'health\n' >>"$ECHO_TEST_OPERATIONS"
MOCK
chmod +x "$case_dir/bin/"*.sh

operations=$case_dir/operations
ECHO_TEST_OPERATIONS=$operations \
ECHO_TEST_RECONCILE_STATE=$case_dir/desired-state-id \
  "$case_dir/bin/finish-resync.sh"

diff -u <(printf 'current\ngateway\nreconcile\nhealth\n') "$operations"

printf 'Analytics resync completion tests passed\n'
