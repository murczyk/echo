#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
COMMAND=$TEST_DIR/../bin/source-verify-deploy.sh
case_dir=

cleanup() {
  [[ -z "$case_dir" ]] || rm -rf -- "$case_dir"
}
trap cleanup EXIT

make_mock() {
  local name=$1
  shift
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    cat
  } >"$case_dir/bin/$name"
  chmod +x "$case_dir/bin/$name"
}

setup_case() {
  cleanup
  case_dir=$(mktemp -d /tmp/echo-source-verify-test.XXXXXX)
  mkdir -p "$case_dir/bin"
  cp "$COMMAND" "$case_dir/bin/source-verify-deploy.sh"
  chmod +x "$case_dir/bin/source-verify-deploy.sh"
  printf 'configured\n' >"$case_dir/source.env"
  : >"$case_dir/operations"

  cat >"$case_dir/bin/lib.sh" <<'LIB'
SOURCE_CONFIG_FILE=${ECHO_PEERDB_SOURCE_CONFIG_FILE:?}
SOURCE_RECONCILE_DEPLOY_RETRY_ATTEMPTS_DEFAULT=5
SOURCE_RECONCILE_DEPLOY_RETRY_DELAY_SECONDS_DEFAULT=30
protected_file_exists() { [[ -f "$1" ]]; }
load_source_config() { ANALYTICS_ADDRESS=192.0.2.10/32; }
require_cmd() { command -v "$1" >/dev/null 2>&1; }
require_paired_control_release() { printf '%064d\n' 0; }
source_reconciliation_failure_is_transient() {
  grep -Eiq \
    'deadlock detected|tuple concurrently updated|another table-selection reconciliation is already running|canceling statement due to lock timeout' \
    <<<"$1"
}
log() { printf '[echo-analytics] %s\n' "$*"; }
die() { printf '[echo-analytics] ERROR: %s\n' "$*" >&2; exit 1; }
LIB
  cat >"$case_dir/bin/source-resnapshot-table.sh" <<'MOCK'
#!/usr/bin/env bash
printf 'resnapshot %s\n' "$*" >>"$ECHO_TEST_OPERATIONS"
MOCK
  chmod +x "$case_dir/bin/source-resnapshot-table.sh"

  make_mock sudo <<'MOCK'
"$@"
MOCK
  make_mock systemctl <<'MOCK'
if [[ $1 == show ]]; then
  printf '0123456789abcdef0123456789abcdef\n'
  exit 0
fi
printf 'systemctl %s\n' "$*" >>"$ECHO_TEST_OPERATIONS"
count_file=$ECHO_TEST_CASE_DIR/systemctl-count
count=0
[[ ! -f $count_file ]] || read -r count <"$count_file"
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
case $ECHO_TEST_SCENARIO in
  transient_then_success)
    ((count > 1))
    ;;
  transient_exhausted|permanent)
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
MOCK
  make_mock journalctl <<'MOCK'
case $ECHO_TEST_SCENARIO in
  transient_*)
    printf 'ERROR: deadlock detected\n'
    ;;
  *)
    printf 'ERROR: mirror entered terminal status 10\n'
    ;;
esac
MOCK
  make_mock ssh <<'MOCK'
printf 'ssh %s\n' "$*" >>"$ECHO_TEST_OPERATIONS"
MOCK
}

run_command() {
  local scenario=$1 attempts=${2:-3}
  set +e
  PATH="$case_dir/bin:/usr/bin:/bin" \
  ECHO_PEERDB_SOURCE_CONFIG_FILE="$case_dir/source.env" \
  ANALYTICS_RECONCILE_DEPLOY_RETRY_ATTEMPTS="$attempts" \
  ANALYTICS_RECONCILE_DEPLOY_RETRY_DELAY_SECONDS=0 \
  ECHO_TEST_CASE_DIR="$case_dir" \
  ECHO_TEST_OPERATIONS="$case_dir/operations" \
  ECHO_TEST_SCENARIO="$scenario" \
    "$case_dir/bin/source-verify-deploy.sh" \
    >"$case_dir/stdout" 2>"$case_dir/stderr"
  command_status=$?
  set -e
}

test_transient_retry_succeeds() {
  setup_case
  run_command transient_then_success
  [[ $command_status -eq 0 ]]
  [[ $(<"$case_dir/systemctl-count") == 2 ]]
  grep -q 'Transient reconciliation contention detected' "$case_dir/stdout"
  grep -q 'succeeded on attempt 2/3' "$case_dir/stdout"
  grep -q '^resnapshot --manifest$' "$case_dir/operations"
}

test_permanent_failure_stops_immediately() {
  setup_case
  run_command permanent
  [[ $command_status -ne 0 ]]
  [[ $(<"$case_dir/systemctl-count") == 1 ]]
  grep -q 'SOURCE TABLE RECONCILIATION FAILED' "$case_dir/stderr"
  grep -q 'not recognized as transient' "$case_dir/stderr"
  ! grep -q '^resnapshot ' "$case_dir/operations"
}

test_transient_retries_are_bounded() {
  setup_case
  run_command transient_exhausted 3
  [[ $command_status -ne 0 ]]
  [[ $(<"$case_dir/systemctl-count") == 3 ]]
  grep -q 'SOURCE TABLE RECONCILIATION IS STILL BLOCKED' "$case_dir/stderr"
  grep -q '3 transient attempts failed' "$case_dir/stderr"
  ! grep -q '^resnapshot ' "$case_dir/operations"
}

test_transient_retry_succeeds
test_permanent_failure_stops_immediately
test_transient_retries_are_bounded
printf 'Source deployment verification tests passed\n'
