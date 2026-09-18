#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
case_dir=$(mktemp -d /tmp/echo-resnapshot-batch.XXXXXX)
trap 'rm -rf -- "$case_dir"' EXIT
export ECHO_ANALYTICS_RESNAPSHOT_TEST_MODE=true
export ECHO_ANALYTICS_LIB=$TEST_DIR/resnapshot-test-lib.sh
source "$TEST_DIR/../bin/resnapshot-table.sh"
export BUNDLE_DIR=$case_dir
export MIRROR_NAME=echo_mirror
export SOURCE_PUBLICATION=echo_publication
export CLICKHOUSE_RAW_DB=echo_cdc
table_resnapshot_state_dir=$case_dir/state
mkdir -p "$table_resnapshot_state_dir" "$case_dir/raw"
operations=$case_dir/operations
: >"$operations"
cat >"$case_dir/migration-impact.json" <<'JSON'
{"migrations":{"repair":{"changes":[
{"table":"public.sigint_network","strategy":"replicated_snapshot","targeted_resnapshot":true},
{"table":"public.signal_group","strategy":"replicated_snapshot","targeted_resnapshot":true},
{"table":"public.user_settings","strategy":"replicated_snapshot","targeted_resnapshot":true}
]}},"dependencies":{}}
JSON
source_table_selected() { return 0; }
mirror_status() { printf '1\n'; }
current_mapping_json() {
  jq -cn --arg source "$1" --arg target "${1#public.}" \
    '{sourceTableIdentifier:$source,destinationTableIdentifier:$target}'
}
source_columns() { printf 'id\nnew_column\n'; }
raw_columns() { cat "$case_dir/raw/$1"; }
raw_table_exists() { [[ -f "$case_dir/raw/$1" ]]; }
ensure_state_dir() { mkdir -p "$table_resnapshot_state_dir"; }
pause_mirror() { printf 'pause\n' >>"$operations"; }
resume_mirror() { printf 'resume\n' >>"$operations"; }
apply_table_edit() { printf '%s\n' "$1" >>"$operations"; }
drop_raw_table_and_view() { printf 'drop %s\n' "$1" >>"$operations"; }
wait_for_table_snapshot() {
  source_columns >"$case_dir/raw/$3"
  printf 'snapshot %s\n' "$3" >>"$operations"
  [[ ! -f "$case_dir/fail-snapshot" ]]
}
refresh_analytics() {
  for table in sigint_network signal_group user_settings; do
    [[ $(raw_columns "$table") == "$(source_columns)" ]]
    [[ -f $(state_file_for_table "public.$table") ]]
  done
  printf 'refresh\n' >>"$operations"
  if [[ -f "$case_dir/fail-refresh" ]]; then
    return 1
  fi
}
leave_mirror_paused() { printf 'recovery-pause\n' >>"$operations"; }

source_columns >"$case_dir/raw/sigint_network"
printf 'id\n' >"$case_dir/raw/signal_group"
printf 'id\n' >"$case_dir/raw/user_settings"
write_state_mapping public.sigint_network replicated_snapshot \
  "$(current_mapping_json public.sigint_network)"
entries=$'replicated_snapshot\tpublic.signal_group\nreplicated_snapshot\tpublic.user_settings'

export table_resnapshot_state_dir
streamed_entries=$(
  {
    printf 'set -euo pipefail\n'
    declare -f validate_batch_entries
    printf "entries=\$(validate_batch_entries <<<'replicated_snapshot\tpublic.user_settings')\n"
    printf 'printf "%%s\\n" "$entries"\n'
  } | bash -s
)
[[ "$streamed_entries" == $'replicated_snapshot\tpublic.sigint_network\nreplicated_snapshot\tpublic.user_settings' ]]

# Authorization and complete preflight must reject the batch before mutation.
if (resnapshot_batch <<<'replicated_snapshot public.unknown') >/dev/null 2>&1; then exit 1; fi
if (resnapshot_batch <<<$'replicated_snapshot\tpublic.unknown') >/dev/null 2>&1; then exit 1; fi
printf 'legacy\n' >>"$case_dir/raw/user_settings"
if (resnapshot_batch <<<"$entries") >/dev/null 2>&1; then exit 1; fi
[[ ! -s "$operations" ]]
printf 'id\n' >"$case_dir/raw/user_settings"

# Interruption after a completed raw snapshot must not rebuild it on retry.
touch "$case_dir/fail-snapshot"
set +e
(
  set -e
  trap handle_exit EXIT
  resnapshot_batch <<<"$entries"
) >"$case_dir/snapshot-failure.log" 2>&1
status=$?
set -e
[[ "$status" != 0 ]]
[[ $(grep -c '^snapshot ' "$operations") == 1 ]]
[[ $(ls -A "$table_resnapshot_state_dir" | wc -l) == 2 ]]
rm -f "$case_dir/fail-snapshot"

# A gateway failure retains every completed snapshot and invokes recovery.
touch "$case_dir/fail-refresh"
set +e
(
  set -e
  trap handle_exit EXIT
  resnapshot_batch <<<"$entries"
) >"$case_dir/failure.log" 2>&1
status=$?
set -e
[[ "$status" != 0 ]]
grep -q '^recovery-pause$' "$operations"
[[ $(ls -A "$table_resnapshot_state_dir" | wc -l) == 3 ]]
rm -f "$case_dir/fail-refresh"
resnapshot_batch <<<"$entries"
[[ $(grep -c '^snapshot ' "$operations") == 2 ]]
! grep -q '^drop sigint_network$' "$operations"
[[ -z $(ls -A "$table_resnapshot_state_dir") ]]
[[ $(tail -n 1 "$operations") == refresh ]]
printf 'Targeted batch repair tests passed\n'
