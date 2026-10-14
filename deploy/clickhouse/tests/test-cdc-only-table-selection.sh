#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
case_dir=$(mktemp -d /tmp/echo-cdc-only-test.XXXXXX)
trap 'rm -rf -- "$case_dir"' EXIT
mkdir -p "$case_dir/bin"
cp "$TEST_DIR/../bin/reconcile-table-selection.sh" "$case_dir/bin/"
export ECHO_TEST_REAL_LIB="$TEST_DIR/../bin/lib.sh"
export ECHO_TEST_CDC_ONLY_FILE="$TEST_DIR/../env/tables-cdc-only.txt"
export ECHO_TEST_CASE_DIR="$case_dir"
export PEERDB_FLOW_BINARY="$case_dir/peer-flow"
printf 'skipInitialSnapshotForTableAdditions\n' >"$PEERDB_FLOW_BINARY"
cat >"$case_dir/bin/lib.sh" <<'LIB'
source "$ECHO_TEST_REAL_LIB"
SOURCE_TABLE_CDC_ONLY_REPO_FILE=$ECHO_TEST_CDC_ONLY_FILE
MIRROR_NAME=echo_test
CLICKHOUSE_RAW_DB=echo_cdc
CLICKHOUSE_CURRENT_DB=echo_analytics
GATEWAY_DB=echo_gateway
load_analytics_config() { :; }
validate_runtime_identifiers() { :; }
acquire_analytics_reconcile_lock() { :; }
require_expected_control_release() { :; }
read_source_tables() {
  SOURCE_TABLES=(public.signal_message public.extra public.attachment_document public.attachment_chunk)
}
source_psql() {
  cat >/dev/null
  printf '%s\n' public.signal_message public.extra public.attachment_document public.attachment_chunk public.stale
}
catalog_psql() { cat >/dev/null; cat "$ECHO_TEST_CASE_DIR/status"; }
peerdb_psql() { printf '2\n' >"$ECHO_TEST_CASE_DIR/status"; }
clickhouse_admin_http() {
  if [[ $1 == *'SELECT name FROM system.tables'* ]]; then
    printf '%s\n' signal_message stale
  elif [[ $1 == *'SELECT count()'* ]]; then
    printf '1\n'
  fi
}
record_attachment_search_cutover() { touch "$ECHO_TEST_CASE_DIR/cutover"; }
ensure_attachment_search_coverage_table() { :; }
postgres_psql() { [[ ! -f "$ECHO_TEST_CASE_DIR/cutover" ]] || printf 't\n'; }
reconcile_analytics_schema_with_retry() { :; }
LIB
cat >"$case_dir/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
while (($#)); do
  if [[ $1 == --data ]]; then
    printf '%s\n' "$2" >>"$ECHO_TEST_CASE_DIR/requests"
    if [[ ${ECHO_TEST_FAIL_CDC:-false} == true ]] && jq -e '.flowConfigUpdate.cdcFlowConfigUpdate.skipInitialSnapshotForTableAdditions' <<<"$2" >/dev/null; then
      exit 22
    fi
    shift
  fi
  shift
done
printf '1\n' >"$ECHO_TEST_CASE_DIR/status"
printf '{}\n'
CURL
chmod +x "$case_dir/bin/curl"
printf '2\n' >"$case_dir/status"
PATH="$case_dir/bin:$PATH" bash "$case_dir/bin/reconcile-table-selection.sh" --yes
jq -se '
  length == 2
  and (.[0].flowConfigUpdate.cdcFlowConfigUpdate.skipInitialSnapshotForTableAdditions // false) == false
  and ([.[0].flowConfigUpdate.cdcFlowConfigUpdate.additionalTables[].sourceTableIdentifier] == ["public.extra"])
  and ([.[0].flowConfigUpdate.cdcFlowConfigUpdate.removedTables[].sourceTableIdentifier] == ["public.stale"])
  and .[1].flowConfigUpdate.cdcFlowConfigUpdate.skipInitialSnapshotForTableAdditions == true
  and ([.[1].flowConfigUpdate.cdcFlowConfigUpdate.additionalTables[].sourceTableIdentifier] | sort == ["public.attachment_chunk", "public.attachment_document"])
' "$case_dir/requests" >/dev/null
[[ -f "$case_dir/cutover" ]]
rm "$case_dir/cutover" "$case_dir/requests"
printf '2\n' >"$case_dir/status"
if ECHO_TEST_FAIL_CDC=true PATH="$case_dir/bin:$PATH" bash "$case_dir/bin/reconcile-table-selection.sh" --yes; then
  printf 'failed CDC-only addition unexpectedly succeeded\n' >&2
  exit 1
fi
[[ ! -f "$case_dir/cutover" ]]
[[ $(<"$case_dir/status") == 2 ]]
rm "$case_dir/requests"
printf 'unsupported-runtime\n' >"$PEERDB_FLOW_BINARY"
if PATH="$case_dir/bin:$PATH" bash "$case_dir/bin/reconcile-table-selection.sh" --yes; then
  printf 'unsupported runtime unexpectedly accepted CDC-only additions\n' >&2
  exit 1
fi
[[ ! -f "$case_dir/requests" && ! -f "$case_dir/cutover" ]]
printf 'CDC-only table selection regression #3780 passed\n'
