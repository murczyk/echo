#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
case_dir=$(mktemp -d /tmp/echo-source-reconcile-test.XXXXXX)
trap 'rm -rf -- "$case_dir"' EXIT

mkdir -p "$case_dir/bin" "$case_dir/state"
for script in source-reconcile-if-needed source-reconcile-tables source-resnapshot-table; do
  cp "$TEST_DIR/../bin/$script.sh" "$case_dir/bin/"
done

cat >"$case_dir/migration-impact.json" <<'JSON'
{"migrations":{"repair":{"changes":[
{"table":"public.user_settings","strategy":"replicated_snapshot","targeted_resnapshot":true},
{"table":"public.message_reply","strategy":"cdc_additive"}
]}},"dependencies":{}}
JSON

cat >"$case_dir/bin/lib.sh" <<'LIB'
source "$ECHO_TEST_SOURCE_LIB"
SCRIPT_DIR=$ECHO_TEST_CASE_DIR/bin
BUNDLE_DIR=$ECHO_TEST_CASE_DIR
protected_file_exists() { return 0; }
load_source_config() {
  SOURCE_DB=test_database
  SOURCE_USER=test_role
  SOURCE_PUBLICATION=test_publication
  ANALYTICS_ADDRESS=192.0.2.10/32
}
require_source_replication_role() { :; }
require_analytics_heartbeat_table() { :; }
require_analytics_heartbeat_selected() { :; }
install_default_source_exclusions() { :; }
read_local_source_tables() { SOURCE_TABLES=(public.message_reply public.user_settings); }
require_paired_control_release() { printf '%064d\n' 0; }
reconcile_source_table_access() { test -f "$ECHO_TEST_CASE_DIR/repaired"; }
reconcile_source_publication() { touch "$ECHO_TEST_CASE_DIR/published"; }
reset_excluded_replica_identities() { :; }
source_local_psql() {
  if [[ $* == *pg_logical_emit_message* ]]; then
    return 0
  fi
  local query
  query=$(cat)
  if [[ $query == *pg_publication_tables* ]]; then
    [[ ! -f $ECHO_TEST_CASE_DIR/published ]] || printf 'public.message_reply\n'
    printf 'public.user_settings\n'
  else
    printf 't\n'
  fi
}
LIB

cat >"$case_dir/bin/ssh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if flock -n "$ECHO_PEERDB_RECONCILE_STATE_DIR/table-selection.lock" true; then
  printf 'source reconciliation lost its lock\n' >&2
  exit 90
fi
case ${!#} in
  *resnapshot-table.sh\ --batch)
    [[ $(cat) == $'replicated_snapshot\tpublic.user_settings' ]]
    printf 'repair\n' >>"$ECHO_TEST_CASE_DIR/operations"
    ((ECHO_TEST_REPAIR_STATUS == 0)) || exit "$ECHO_TEST_REPAIR_STATUS"
    touch "$ECHO_TEST_CASE_DIR/repaired"
    ;;
  *reconcile-table-selection.sh\ --pause)
    [[ -f $ECHO_TEST_CASE_DIR/repaired ]] || {
      printf 'user_settings schema was not repaired before table reconciliation\n' >&2
      exit 3
    }
    printf 'pause\n' >>"$ECHO_TEST_CASE_DIR/operations"
    ;;
  *reconcile-table-selection.sh\ --yes)
    [[ -f $ECHO_TEST_CASE_DIR/repaired && -f $ECHO_TEST_CASE_DIR/published ]]
    printf 'apply\n' >>"$ECHO_TEST_CASE_DIR/operations"
    ;;
  test\ -x\ *)
    ;;
  *)
    printf 'unexpected remote command: %s\n' "${!#}" >&2
    exit 91
    ;;
esac
MOCK
chmod +x "$case_dir/bin/ssh"

run_reconciliation() {
  PATH="$case_dir/bin:$PATH" \
  ECHO_TEST_SOURCE_LIB="$TEST_DIR/../bin/lib.sh" \
  ECHO_TEST_CASE_DIR="$case_dir" \
  ECHO_TEST_REPAIR_STATUS="$1" \
  ECHO_PEERDB_RECONCILE_STATE_DIR="$case_dir/state" \
  ECHO_PEERDB_LIB="$case_dir/bin/lib.sh" \
  SOURCE_RECONCILE_LOCK_WAIT_SECONDS=1 \
  SOURCE_RECONCILE_LOCK_BUSY_IS_SUCCESS=true \
    bash "$case_dir/bin/source-reconcile-if-needed.sh"
}

run_reconciliation 0
[[ $(cat "$case_dir/operations") == $'repair\npause\napply' ]]
[[ -s "$case_dir/state/table-selection.sha256" ]]
run_reconciliation 0
[[ $(cat "$case_dir/operations") == $'repair\npause\napply' ]]

rm "$case_dir/repaired" "$case_dir/published" "$case_dir/operations"
printf 'baseline\n' >"$case_dir/state/table-selection.sha256"
status=0
run_reconciliation 3 || status=$?
[[ $status -eq 3 ]]
[[ $(cat "$case_dir/operations") == repair ]]
[[ ! -e "$case_dir/published" ]]
[[ $(cat "$case_dir/state/table-selection.sha256") == baseline ]]

printf 'Automatic source reconciliation repair tests passed\n'
