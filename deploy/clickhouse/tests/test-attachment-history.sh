#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
case_dir=$(mktemp -d /tmp/echo-attachment-history-test.XXXXXX)
trap 'rm -rf -- "$case_dir"' EXIT
export ECHO_TEST_CASE_DIR=$case_dir
cp "$TEST_DIR/../bin/oneoff-replicate-attachment-history.sh" "$case_dir/"
cat >"$case_dir/lib.sh" <<'LIB'
GATEWAY_DB=echo_gateway
ensure_yes() { [[ ${1:-} == --yes ]]; }
delegate_paired_analytics_operation_if_source() { :; }
load_analytics_config() { :; }
validate_runtime_identifiers() { :; }
acquire_analytics_reconcile_lock() { :; }
require_expected_control_release() { :; }
ensure_attachment_search_coverage_table() { :; }
log() { :; }
source_psql() { printf '2026-10-14 12:00:00\n'; }
postgres_psql() {
  local sql
  sql=$(cat)
  if [[ $sql == *'history_complete=false'* ]]; then
    printf 'incomplete\n' >"$ECHO_TEST_CASE_DIR/coverage"
  elif [[ $sql == *'history_complete=true'* ]]; then
    [[ $(<"$ECHO_TEST_CASE_DIR/snapshots") == $'public.attachment_document\npublic.attachment_chunk' ]]
    [[ -f "$ECHO_TEST_CASE_DIR/healthy" ]]
    printf 'complete\n' >"$ECHO_TEST_CASE_DIR/coverage"
  else
    return 1
  fi
}
LIB
cat >"$case_dir/resnapshot-table.sh" <<'SNAPSHOT'
#!/usr/bin/env bash
set -euo pipefail
[[ $# == 4 && $1 == --strategy && $2 == replicated_snapshot && $4 == --force ]]
[[ $(<"$ECHO_TEST_CASE_DIR/coverage") == incomplete ]]
[[ $3 != "${ECHO_TEST_FAIL_TABLE:-}" ]]
printf '%s\n' "$3" >>"$ECHO_TEST_CASE_DIR/snapshots"
SNAPSHOT
cat >"$case_dir/check-analytics-health.sh" <<'HEALTH'
#!/usr/bin/env bash
set -euo pipefail
[[ ${ECHO_TEST_FAIL_HEALTH:-false} == false ]]
touch "$ECHO_TEST_CASE_DIR/healthy"
HEALTH
chmod +x "$case_dir/resnapshot-table.sh" "$case_dir/check-analytics-health.sh"

for failure in none document chunk health; do
  rm -f "$case_dir/coverage" "$case_dir/snapshots" "$case_dir/healthy"
  export ECHO_TEST_FAIL_TABLE= ECHO_TEST_FAIL_HEALTH=false
  case $failure in
    document) ECHO_TEST_FAIL_TABLE=public.attachment_document ;;
    chunk) ECHO_TEST_FAIL_TABLE=public.attachment_chunk ;;
    health) ECHO_TEST_FAIL_HEALTH=true ;;
  esac
  if bash "$case_dir/oneoff-replicate-attachment-history.sh" --yes; then
    [[ $failure == none && $(<"$case_dir/coverage") == complete ]]
  else
    [[ $failure != none && $(<"$case_dir/coverage") == incomplete ]]
  fi
done
printf 'Attachment history coverage regression #3780 passed\n'
