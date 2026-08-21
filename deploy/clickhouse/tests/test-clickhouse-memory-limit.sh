#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
COMMAND=$TEST_DIR/../bin/reconcile-clickhouse-memory-limit.sh
case_dir=$(mktemp -d /tmp/echo-clickhouse-memory-limit-test.XXXXXX)
cleanup() {
  rm -rf -- "$case_dir"
}
trap cleanup EXIT

mkdir -p "$case_dir/bin" "$case_dir/config"
cp "$COMMAND" "$case_dir/bin/reconcile-clickhouse-memory-limit.sh"
chmod +x "$case_dir/bin/reconcile-clickhouse-memory-limit.sh"
cat >"$case_dir/bin/lib.sh" <<'LIB'
load_analytics_config() { :; }
clickhouse_memory_limit_bytes() { printf '18000000000\n'; }
clickhouse_admin() {
  if [[ "$*" == *'SYSTEM RELOAD CONFIG'* ]]; then
    printf 'reload\n' >>"$ECHO_TEST_OPERATIONS"
  else
    printf '%s\n' "${ECHO_TEST_CONFIGURED_LIMIT:-0}"
  fi
}
log() { :; }
die() { printf '%s\n' "$*" >&2; exit 1; }
LIB

config_file=$case_dir/config/echo-memory-limit.xml
operations=$case_dir/operations
run_reconcile() {
  ANALYTICS_CLICKHOUSE_MEMORY_CONFIG_FILE="$config_file" \
  ECHO_TEST_OPERATIONS="$operations" \
  ECHO_TEST_CONFIGURED_LIMIT=18000000000 \
    "$case_dir/bin/reconcile-clickhouse-memory-limit.sh" "$@"
}

run_reconcile
grep -q '<max_server_memory_usage>18000000000</max_server_memory_usage>' "$config_file"
[[ $(grep -c '^reload$' "$operations") == 1 ]]
run_reconcile --check

printf '<clickhouse/>\n' >"$config_file"
run_reconcile --check
if ANALYTICS_CLICKHOUSE_MEMORY_CONFIG_FILE="$config_file" \
  ECHO_TEST_OPERATIONS="$operations" \
  ECHO_TEST_CONFIGURED_LIMIT=17000000000 \
    "$case_dir/bin/reconcile-clickhouse-memory-limit.sh" --check >/dev/null 2>&1
then
  printf 'check unexpectedly accepted stale live memory limit\n' >&2
  exit 1
fi

meminfo_file=$case_dir/meminfo
cgroup_file=$case_dir/memory.max
printf 'MemTotal:       67108864 kB\n' >"$meminfo_file"
printf '34359738368\n' >"$cgroup_file"
calculated_limit=$(
  # shellcheck source=../bin/lib.sh
  source "$TEST_DIR/../bin/lib.sh"
  ANALYTICS_PROC_MEMINFO_FILE="$meminfo_file" \
  ANALYTICS_CGROUP_V2_MEMORY_MAX_FILE="$cgroup_file" \
  ANALYTICS_CGROUP_V1_MEMORY_MAX_FILE="$case_dir/missing" \
    clickhouse_memory_limit_bytes
)
[[ "$calculated_limit" == 18897856102 ]]

printf 'ClickHouse memory-limit reconciliation tests passed\n'
