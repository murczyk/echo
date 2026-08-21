#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
COMMAND=$TEST_DIR/../bin/reconcile-if-needed.sh
case_dir=$(mktemp -d /tmp/echo-reconcile-if-needed-test.XXXXXX)
cleanup() {
  rm -rf -- "$case_dir"
}
trap cleanup EXIT

mkdir -p "$case_dir/bin" "$case_dir/state"
cp "$COMMAND" "$case_dir/bin/reconcile-if-needed.sh"
chmod +x "$case_dir/bin/reconcile-if-needed.sh"
cat >"$case_dir/bin/lib.sh" <<'LIB'
ANALYTICS_RECONCILE_STATE_DIR=${ECHO_TEST_STATE_DIR:?}
ANALYTICS_RECONCILE_STATE_FILE=$ANALYTICS_RECONCILE_STATE_DIR/desired-state-id
load_analytics_config() { :; }
validate_runtime_identifiers() { :; }
acquire_analytics_reconcile_lock() { :; }
require_expected_control_release() { :; }
analytics_desired_state_id() { printf '%064d\n' 1; }
log() { :; }
die() { printf '%s\n' "$*" >&2; exit 1; }
LIB
cat >"$case_dir/bin/reconcile-schema.sh" <<'MOCK'
#!/usr/bin/env bash
printf 'schema %s\n' "$*" >>"$ECHO_TEST_OPERATIONS"
MOCK
cat >"$case_dir/bin/reconcile-clickhouse-memory-limit.sh" <<'MOCK'
#!/usr/bin/env bash
printf 'memory %s\n' "$*" >>"$ECHO_TEST_OPERATIONS"
MOCK
cat >"$case_dir/bin/reconcile-gateway-settings.sh" <<'MOCK'
#!/usr/bin/env bash
printf 'gateway %s\n' "$*" >>"$ECHO_TEST_OPERATIONS"
MOCK
cat >"$case_dir/bin/reconcile-derived-schema.sh" <<'MOCK'
#!/usr/bin/env bash
printf 'derived\n' >>"$ECHO_TEST_OPERATIONS"
MOCK
chmod +x \
  "$case_dir/bin/reconcile-clickhouse-memory-limit.sh" \
  "$case_dir/bin/reconcile-gateway-settings.sh" \
  "$case_dir/bin/reconcile-schema.sh" \
  "$case_dir/bin/reconcile-derived-schema.sh"

operations=$case_dir/operations
run_reconcile() {
  ECHO_TEST_STATE_DIR="$case_dir/state" \
  ECHO_TEST_OPERATIONS="$operations" \
    "$case_dir/bin/reconcile-if-needed.sh" "$@"
}

run_reconcile
[[ $(grep -c '^memory --check$' "$operations") == 1 ]]
[[ $(grep -c '^schema $' "$operations") == 1 ]]
[[ $(grep -c '^derived$' "$operations") == 1 ]]
[[ $(<"$case_dir/state/desired-state-id") == "$(printf '%064d' 1)" ]]
grep -q 'install -d -m 0755' "$COMMAND"
if grep -q 'install -d -o' "$COMMAND"; then
  printf 'reconciliation unexpectedly changes the shared state-directory owner\n' >&2
  exit 1
fi

run_reconcile
[[ $(grep -c '^memory --check$' "$operations") == 2 ]]
[[ $(grep -c '^schema $' "$operations") == 2 ]]
[[ $(grep -c '^derived$' "$operations") == 1 ]]

run_reconcile --check
[[ $(grep -c '^memory --check$' "$operations") == 3 ]]
grep -q '^schema --check$' "$operations"
[[ $(grep -c '^derived$' "$operations") == 1 ]]

touch -d '@1' "$case_dir/state/desired-state-id"
if run_reconcile --check >/dev/null 2>&1; then
  printf 'check unexpectedly accepted stale reconciliation freshness\n' >&2
  exit 1
fi

rm "$case_dir/state/desired-state-id"
if run_reconcile --check >/dev/null 2>&1; then
  printf 'check unexpectedly accepted a stale derived release\n' >&2
  exit 1
fi
[[ $(grep -c '^derived$' "$operations") == 1 ]]

printf 'Analytics desired-state reconciliation tests passed\n'
