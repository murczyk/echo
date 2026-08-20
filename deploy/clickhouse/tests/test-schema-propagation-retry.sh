#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../bin/lib.sh
source "$TEST_DIR/../bin/lib.sh"

case_dir=$(mktemp -d /tmp/echo-schema-propagation-retry-test.XXXXXX)
cleanup() {
  rm -rf -- "$case_dir"
}
trap cleanup EXIT

mkdir -p "$case_dir/bin"
for command in refresh-current-views reconcile-schema check-analytics-health; do
  cat >"$case_dir/bin/$command.sh" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$(basename "$0" .sh)" >>"$ECHO_TEST_OPERATIONS"
MOCK
done
cat >"$case_dir/bin/refresh-gateway.sh" <<'MOCK'
#!/usr/bin/env bash
printf 'refresh-gateway\n' >>"$ECHO_TEST_OPERATIONS"
attempt=$(wc -l <"$ECHO_TEST_GATEWAY_ATTEMPTS")
printf 'attempt\n' >>"$ECHO_TEST_GATEWAY_ATTEMPTS"
((attempt > 0))
MOCK
chmod +x "$case_dir/bin/"*.sh

operations=$case_dir/operations
gateway_attempts=$case_dir/gateway-attempts
: >"$gateway_attempts"
ECHO_TEST_OPERATIONS=$operations \
ECHO_TEST_GATEWAY_ATTEMPTS=$gateway_attempts \
MIRROR_TABLE_RECONCILE_SCHEMA_RETRY_ATTEMPTS=2 \
MIRROR_TABLE_RECONCILE_SCHEMA_RETRY_DELAY_SECONDS=0 \
MIRROR_TABLE_RECONCILE_SCHEMA_RETRY_TIMEOUT_SECONDS=300 \
  reconcile_analytics_schema_with_retry "$case_dir/bin"

diff -u \
  <(printf 'refresh-current-views\nrefresh-gateway\nrefresh-current-views\nrefresh-gateway\nreconcile-schema\ncheck-analytics-health\n') \
  "$operations"

: >"$gateway_attempts"
if ECHO_TEST_OPERATIONS=$operations \
  ECHO_TEST_GATEWAY_ATTEMPTS=$gateway_attempts \
  MIRROR_TABLE_RECONCILE_SCHEMA_RETRY_ATTEMPTS=1 \
  MIRROR_TABLE_RECONCILE_SCHEMA_RETRY_DELAY_SECONDS=0 \
  MIRROR_TABLE_RECONCILE_SCHEMA_RETRY_TIMEOUT_SECONDS=300 \
    reconcile_analytics_schema_with_retry "$case_dir/bin"; then
  printf 'schema reconciliation unexpectedly accepted exhausted retries\n' >&2
  exit 1
fi

for source_script in \
  source-reconcile-derived-schema.sh \
  source-reconcile-tables.sh
do
  grep -q '"sudo -n env ECHO_ANALYTICS_EXPECTED_CONTROL_RELEASE=' \
    "$TEST_DIR/../bin/$source_script"
done

printf 'Analytics schema propagation retry tests passed\n'
