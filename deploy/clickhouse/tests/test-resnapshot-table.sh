#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
SCRIPT_DIR=$(cd "$TEST_DIR/../bin" && pwd)

run_case() {
  local scenario=$1 expected_status=$2 case_dir status
  case_dir=$(mktemp -d /tmp/echo-resnapshot-test.XXXXXX)
  if ECHO_RESNAPSHOT_TEST_CASE_DIR="$case_dir" "$0" "$scenario"; then
    status=0
  else
    status=$?
  fi
  if [[ "$expected_status" == success ]]; then
    [[ "$status" == 0 ]] || {
      printf 'scenario %s unexpectedly failed\n' "$scenario" >&2
      return 1
    }
  else
    [[ "$status" != 0 ]] || {
      printf 'scenario %s unexpectedly succeeded\n' "$scenario" >&2
      return 1
    }
  fi
  case $scenario in
    nonempty|raw_only|strategy_mismatch|terminal_state|cdc_timeout)
      ! grep -Eq '^(pause|remove|drop|add|refresh)' "$case_dir/operations"
      ;;
    cdc_race)
      ! grep -Eq '^(remove|drop|add|snapshot)' "$case_dir/operations"
      ;;
    recoverable_failure)
      grep -q '^recovery-pause$' "$case_dir/operations"
      ;;
  esac
  rm -rf -- "$case_dir"
}

if [[ $# -eq 0 ]]; then
  run_case cdc_paused success
  run_case cdc_propagated success
  run_case cdc_timeout failure
  run_case cdc_empty success
  run_case cdc_race failure
  run_case no_drift success
  run_case additive_empty success
  run_case additive_nonempty success
  run_case nonempty failure
  run_case raw_only failure
  run_case mapping_preserved success
  run_case interrupted_retry success
  run_case refresh_reconciles_state success
  run_case strategy_mismatch failure
  run_case terminal_state failure
  run_case recoverable_failure failure
  printf 'Targeted table resnapshot tests passed\n'
  exit 0
fi

scenario=$1
case_dir=${ECHO_RESNAPSHOT_TEST_CASE_DIR:?}
operations_file=$case_dir/operations
state_dir=$case_dir/state
touch "$operations_file"

export ECHO_ANALYTICS_RESNAPSHOT_TEST_MODE=true
export ECHO_ANALYTICS_LIB=$TEST_DIR/resnapshot-test-lib.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/resnapshot-table.sh"

if [[ $scenario == refresh_reconciles_state ]]; then
  analytics_bin_dir=$case_dir/bin
  mkdir -p "$analytics_bin_dir"
  for helper in \
    refresh-current-views.sh \
    refresh-gateway.sh \
    reconcile-schema.sh \
    reconcile-if-needed.sh \
    check-analytics-health.sh
  do
    cat >"$analytics_bin_dir/$helper" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
helper=${0##*/}
printf '%s\n' "$helper" >>"$ECHO_RESNAPSHOT_TEST_CASE_DIR/operations"
if [[ $helper == reconcile-if-needed.sh ]]; then
  touch "$ECHO_RESNAPSHOT_TEST_CASE_DIR/reconciled"
elif [[ $helper == check-analytics-health.sh ]]; then
  [[ -f "$ECHO_RESNAPSHOT_TEST_CASE_DIR/reconciled" ]]
fi
MOCK
    chmod +x "$analytics_bin_dir/$helper"
  done
  refresh_analytics
  diff -u \
    <(printf '%s\n' \
      refresh-current-views.sh \
      refresh-gateway.sh \
      reconcile-schema.sh \
      reconcile-if-needed.sh \
      check-analytics-health.sh) \
    "$operations_file"
  exit 0
fi

# shellcheck disable=SC2034
MIRROR_NAME=echo_mirror
# shellcheck disable=SC2034
SOURCE_PUBLICATION=echo_publication
# shellcheck disable=SC2034
CLICKHOUSE_RAW_DB=echo_cdc
# shellcheck disable=SC2034
CLICKHOUSE_CURRENT_DB=echo_analytics
# shellcheck disable=SC2034
table_resnapshot_timeout=1
# shellcheck disable=SC2034
table_resnapshot_poll_interval=1
table_resnapshot_state_dir=$state_dir
mock_mapping='{"sourceTableIdentifier":"public.echo_automation","destinationTableIdentifier":"echo_automation","partitionKey":"","exclude":[],"columns":[],"engine":"CH_ENGINE_REPLACING_MERGE_TREE","shardingKey":"","policyName":"","partitionByExpr":""}'
mock_source_columns=$'id\ncoordinates_screenshot'
mock_raw_columns=$'id'
mock_raw_exists=true
mock_has_rows=false
mock_status=1

source_table_selected() {
  return 0
}

mirror_status() {
  printf '%s\n' "$mock_status"
}

current_mapping_json() {
  [[ -n "$mock_mapping" ]] && printf '%s\n' "$mock_mapping"
  return 0
}

source_columns() {
  printf '%s\n' "$mock_source_columns"
}

raw_columns() {
  printf '%s\n' "$mock_raw_columns"
}

raw_table_exists() {
  [[ "$mock_raw_exists" == true ]]
}

source_table_has_rows() {
  printf 'checked-rows\n' >>"$operations_file"
  [[ "$mock_has_rows" == true ]]
}

ensure_state_dir() {
  mkdir -p "$table_resnapshot_state_dir"
}

pause_mirror() {
  printf 'pause\n' >>"$operations_file"
  mock_status=2
}

resume_mirror() {
  printf 'resume\n' >>"$operations_file"
  mock_status=1
}

apply_table_edit() {
  local action=$1 mapping=$2
  printf '%s\t%s\n' "$action" "$(canonical_mapping "$mapping")" >>"$operations_file"
  if [[ "$action" == remove ]]; then
    mock_mapping=
  else
    mock_mapping=$mapping
    mock_raw_exists=true
    mock_raw_columns=$mock_source_columns
  fi
  mock_status=1
}

drop_raw_table_and_view() {
  printf 'drop\t%s\n' "$1" >>"$operations_file"
  mock_raw_exists=false
  mock_raw_columns=
}

wait_for_table_snapshot() {
  local expected_mapping=$2
  [[ "$mock_raw_exists" == true ]]
  [[ "$mock_raw_columns" == "$mock_source_columns" ]]
  mappings_equal "$mock_mapping" "$expected_mapping"
  printf 'snapshot\n' >>"$operations_file"
}

refresh_analytics() {
  printf 'refresh\n' >>"$operations_file"
}

case $scenario in
  no_drift)
    mock_raw_columns=$mock_source_columns
    mock_has_rows=true
    resnapshot_table empty_table_resnapshot public.echo_automation
    [[ ! -s "$operations_file" ]]
    ;;
  additive_empty)
    resnapshot_table empty_table_resnapshot public.echo_automation
    grep -q '^remove' "$operations_file"
    grep -q '^drop' "$operations_file"
    grep -q '^add' "$operations_file"
    grep -q '^snapshot$' "$operations_file"
    grep -q '^refresh$' "$operations_file"
    ;;
  cdc_propagated|cdc_paused)
    if [[ "$scenario" == cdc_paused ]]; then
      mock_status=2
    fi
    mock_has_rows=true
    raw_columns() {
      if [[ -f "$case_dir/cdc-read" ]]; then
        printf '%s\n' "$mock_source_columns"
      else
        touch "$case_dir/cdc-read"
        printf '%s\n' "$mock_raw_columns"
      fi
    }
    resnapshot_table cdc_additive public.echo_automation
    ! grep -Eq '^(pause|remove|drop|add|snapshot)' "$operations_file"
    if [[ "$scenario" == cdc_paused ]]; then
      grep -q '^resume$' "$operations_file"
    fi
    ;;
  cdc_timeout)
    mock_has_rows=true
    table_cdc_timeout=1
    table_resnapshot_poll_interval=1
    resnapshot_table cdc_additive public.echo_automation
    ;;
  cdc_empty)
    resnapshot_table cdc_additive public.echo_automation
    grep -q '^snapshot$' "$operations_file"
    ;;
  cdc_race)
    source_table_has_rows() {
      grep -q '^pause' "$operations_file"
    }
    resnapshot_table cdc_additive public.echo_automation
    ;;
  additive_nonempty)
    mock_has_rows=true
    resnapshot_table replicated_snapshot public.echo_automation
    ! grep -q '^checked-rows$' "$operations_file"
    grep -q '^remove' "$operations_file"
    grep -q '^drop' "$operations_file"
    grep -q '^add' "$operations_file"
    grep -q '^snapshot$' "$operations_file"
    grep -q '^refresh$' "$operations_file"
    ;;
  nonempty)
    mock_has_rows=true
    resnapshot_table empty_table_resnapshot public.echo_automation
    ;;
  raw_only)
    mock_source_columns=id
    mock_raw_columns=$'id\nlegacy'
    resnapshot_table empty_table_resnapshot public.echo_automation
    ;;
  mapping_preserved)
    mock_mapping='{"sourceTableIdentifier":"public.echo_automation","destinationTableIdentifier":"custom_automation"}'
    expected_mapping=$(canonical_mapping "$mock_mapping")
    resnapshot_table empty_table_resnapshot public.echo_automation
    grep -Fq $'add\t'"$expected_mapping" "$operations_file"
    grep -q $'^drop\tcustom_automation$' "$operations_file"
    ;;
  interrupted_retry)
    ensure_state_dir
    write_state_mapping public.echo_automation replicated_snapshot "$mock_mapping"
    mock_mapping=
    mock_raw_exists=false
    mock_raw_columns=
    resnapshot_table replicated_snapshot public.echo_automation
    ! grep -q '^remove' "$operations_file"
    grep -q '^add' "$operations_file"
    grep -q '^refresh$' "$operations_file"
    ;;
  strategy_mismatch)
    ensure_state_dir
    write_state_mapping public.echo_automation empty_table_resnapshot "$mock_mapping"
    resnapshot_table replicated_snapshot public.echo_automation
    ;;
  terminal_state)
    mock_status=10
    resnapshot_table empty_table_resnapshot public.echo_automation
    ;;
  recoverable_failure)
    leave_mirror_paused() {
      printf 'recovery-pause\n' >>"$operations_file"
    }
    # shellcheck disable=SC2034
    mutation_started=true
    # shellcheck disable=SC2034
    repair_complete=false
    set +e
    false
    handle_exit
    ;;
  *)
    printf 'unknown scenario: %s\n' "$scenario" >&2
    exit 1
    ;;
esac
