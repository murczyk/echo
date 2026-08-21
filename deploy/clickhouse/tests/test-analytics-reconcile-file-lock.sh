#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
LIB=$TEST_DIR/../bin/lib.sh
case_dir=$(mktemp -d /tmp/echo-analytics-file-lock-test.XXXXXX)
holder_pid=
cleanup() {
  if [[ -n "$holder_pid" ]]; then
    kill "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
  fi
  rm -rf -- "$case_dir"
}
trap cleanup EXIT

lock_file=$case_dir/reconcile.lock
ready_file=$case_dir/ready
(
  exec 9>"$lock_file"
  flock 9
  : >"$ready_file"
  while true; do
    sleep 1
  done
) &
holder_pid=$!

for _ in $(seq 1 50); do
  [[ -f "$ready_file" ]] && break
  sleep 0.1
done
[[ -f "$ready_file" ]]

busy_output=$(ECHO_ANALYTICS_RECONCILE_LOCK_FILE="$lock_file" \
  ANALYTICS_RECONCILE_LOCK_WAIT_SECONDS=0 \
  ANALYTICS_RECONCILE_LOCK_BUSY_IS_SUCCESS=true \
  bash -c 'source "$1"; acquire_analytics_reconcile_lock' _ "$LIB")
grep -q 'skipping this timer run' <<<"$busy_output"

if ECHO_ANALYTICS_RECONCILE_LOCK_FILE="$lock_file" \
  ANALYTICS_RECONCILE_LOCK_WAIT_SECONDS=0 \
  bash -c 'source "$1"; acquire_analytics_reconcile_lock' _ "$LIB" \
  >/dev/null 2>&1; then
  printf 'busy analytics lock unexpectedly succeeded without timer mode\n' >&2
  exit 1
fi

printf 'Analytics reconciliation file-lock tests passed\n'
