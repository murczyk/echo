#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
case_dir=$(mktemp -d /tmp/echo-gateway-limits-test.XXXXXX)
trap 'rm -rf -- "$case_dir"' EXIT
mkdir -p "$case_dir/bin"
cp "$TEST_DIR/../bin/reconcile-gateway-limits.sh" "$case_dir/bin/"
cat >"$case_dir/bin/lib.sh" <<'LIB'
load_analytics_config() { CLICKHOUSE_GATEWAY_USER=echo_gateway; }
validate_runtime_identifiers() { :; }
clickhouse_memory_limit_bytes() { printf '17179869184\n'; }
log() { :; }
die() { printf '%s\n' "$*" >&2; exit 1; }
clickhouse_admin() {
  local query=$2
  if [[ "$query" == *'SELECT count()'* ]]; then
    [[ ${ECHO_TEST_READ_FAILURE:-false} != true ]] || return 1
    [[ "$query" == *"user_name = 'echo_gateway'"* ]]
    [[ "$query" == *"min = '1'"* ]]
    if [[ -f "$ECHO_TEST_STATE" ]]; then printf '4\n'; else printf '0\n'; fi
  elif [[ "$query" == *'ALTER USER echo_gateway SETTINGS'* ]]; then
    [[ "$query" == *'max_memory_usage = 2147483648 MIN 1 MAX 2147483648'* ]]
    [[ "$query" == *'max_memory_usage_for_user = 8589934592 MIN 1 MAX 8589934592'* ]]
    [[ "$query" == *'max_threads = 4 MIN 1 MAX 4'* ]]
    [[ "$query" == *'max_concurrent_queries_for_user = 32 MIN 1 MAX 32'* ]]
    printf 'alter\n' >>"$ECHO_TEST_OPERATIONS"
    [[ ${ECHO_TEST_APPLY_FAILURE:-false} != true ]] || return 1
    touch "$ECHO_TEST_STATE"
  else
    return 1
  fi
}
LIB
export ECHO_TEST_STATE=$case_dir/state
export ECHO_TEST_OPERATIONS=$case_dir/operations
command=$case_dir/bin/reconcile-gateway-limits.sh

if bash "$command" --check >/dev/null 2>&1; then
  printf 'check accepted missing limits\n' >&2
  exit 1
fi
[[ ! -e "$ECHO_TEST_STATE" && ! -e "$ECHO_TEST_OPERATIONS" ]]
bash "$command"
bash "$command" --check
bash "$command"
[[ $(wc -l <"$ECHO_TEST_OPERATIONS") == 1 ]]

rm "$ECHO_TEST_STATE"
if ECHO_TEST_READ_FAILURE=true bash "$command" >/dev/null 2>&1; then
  printf 'reconciliation accepted a failed settings read\n' >&2
  exit 1
fi
[[ $(wc -l <"$ECHO_TEST_OPERATIONS") == 1 ]]
if ECHO_TEST_APPLY_FAILURE=true bash "$command" >/dev/null 2>&1; then
  printf 'reconciliation accepted a failed settings update\n' >&2
  exit 1
fi
[[ ! -e "$ECHO_TEST_STATE" ]]
for invalid in 0 76 abc; do
  if ANALYTICS_GATEWAY_MEMORY_LIMIT_PERCENT=$invalid bash "$command" >/dev/null 2>&1; then
    printf 'reconciliation accepted an invalid memory percentage\n' >&2
    exit 1
  fi
done
printf 'Gateway resource-limit reconciliation tests passed\n'
