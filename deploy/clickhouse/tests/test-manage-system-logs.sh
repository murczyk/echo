#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
COMMAND=$TEST_DIR/../bin/manage-system-logs.sh
case_dir=

cleanup() {
  [[ -z "$case_dir" ]] || rm -rf -- "$case_dir"
}
trap cleanup EXIT

setup_case() {
  cleanup
  case_dir=$(mktemp -d /tmp/echo-system-log-test.XXXXXX)
  fake_bin=$case_dir/bin
  operations=$case_dir/operations
  state_dir=$case_dir/state
  config_dir=$case_dir/config.d
  instance_file=$case_dir/instance.env
  secrets_file=$case_dir/clickhouse.env
  server_config=$case_dir/config.xml
  mkdir -p "$fake_bin" "$state_dir" "$config_dir"
  : >"$operations"
  printf 'CLICKHOUSE_NATIVE_PORT=9000\n' >"$instance_file"
  printf 'CLICKHOUSE_ADMIN_PASSWORD=test-secret\n' >"$secrets_file"
  printf '<clickhouse/>\n' >"$server_config"

  make_sudo_mock
  make_systemctl_mock
  make_clickhouse_mock
  make_clickhouse_client_mock
}

make_mock() {
  local name=$1
  shift
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    cat
  } >"$fake_bin/$name"
  chmod +x "$fake_bin/$name"
}

make_sudo_mock() {
  make_mock sudo <<'MOCK'
printf 'sudo' >>"$ECHO_TEST_OPERATIONS"
printf ' %s' "$@" >>"$ECHO_TEST_OPERATIONS"
printf '\n' >>"$ECHO_TEST_OPERATIONS"
case ${1:-} in
  chown)
    exit 0
    ;;
esac
"$@"
MOCK
}

make_systemctl_mock() {
  make_mock systemctl <<'MOCK'
printf 'systemctl %s\n' "$*" >>"$ECHO_TEST_OPERATIONS"
if [[ ${ECHO_TEST_SCENARIO:-} == restart_command_failure ]]; then
  exit 1
fi
touch "$ECHO_TEST_STATE/restarted"
MOCK
}

make_clickhouse_mock() {
  make_mock clickhouse <<'MOCK'
config_file= key=
while (($# > 0)); do
  case $1 in
    --config-file)
      config_file=$2
      shift 2
      ;;
    --config-file=*)
      config_file=${1#*=}
      shift
      ;;
    --key)
      key=$2
      shift 2
      ;;
    --key=*)
      key=${1#*=}
      shift
      ;;
    *)
      shift
      ;;
  esac
done
printf 'parse %s %s\n' "$config_file" "$key" >>"$ECHO_TEST_OPERATIONS"
if [[ ${ECHO_TEST_SCENARIO:-} == config_parse_failure && $key == query_log.ttl ]]; then
  exit 1
fi
case $key in
  logger.level|text_log.level)
    printf 'information\n'
    ;;
  text_log.ttl)
    printf 'event_date + INTERVAL 3 DAY DELETE\n'
    ;;
  query_log.ttl)
    printf 'event_date + INTERVAL 7 DAY DELETE\n'
    ;;
  trace_log.ttl|processors_profile_log.ttl)
    printf 'event_date + INTERVAL 1 DAY DELETE\n'
    ;;
  *)
    exit 1
    ;;
esac
MOCK
}

make_clickhouse_client_mock() {
  make_mock clickhouse-client <<'MOCK'
[[ ${CLICKHOUSE_PASSWORD:-} == test-secret ]] || exit 1
query=
while (($# > 0)); do
  if [[ $1 == --query ]]; then
    query=$2
    break
  fi
  shift
done
printf '%s\n' "$query" >>"$ECHO_TEST_OPERATIONS"
case $query in
  'SELECT 1')
    if [[ ${ECHO_TEST_SCENARIO:-} == pre_health_failure ]]; then
      exit 1
    fi
    if [[ ${ECHO_TEST_SCENARIO:-} == post_restart_health_failure \
      && -f $ECHO_TEST_STATE/restarted ]]; then
      exit 1
    fi
    printf '1\n'
    ;;
  *"name = 'logger.level'"*)
    printf 'information\n'
    ;;
  *"name = 'text_log'"*)
    printf '0\t0.00 B\tMergeTree ORDER BY event_date TTL event_date + toIntervalDay(3)\n'
    ;;
  *"name = 'query_log'"*)
    if [[ ${ECHO_TEST_SCENARIO:-} == ttl_drift ]]; then
      printf '0\t0.00 B\tMergeTree ORDER BY event_date TTL event_date + toIntervalDay(30)\n'
    else
      printf '0\t0.00 B\tMergeTree ORDER BY event_date TTL event_date + toIntervalDay(7)\n'
    fi
    ;;
  *"name = 'trace_log'"*)
    printf '0\t0.00 B\tMergeTree ORDER BY event_date TTL event_date + toIntervalDay(1)\n'
    ;;
  *"name = 'processors_profile_log'"*)
    printf '0\t0.00 B\tMergeTree ORDER BY event_date TTL event_date + toIntervalDay(1)\n'
    ;;
esac
if [[ ${ECHO_TEST_SCENARIO:-} == truncate_failure \
  && $query == 'TRUNCATE TABLE system.query_log SYNC SETTINGS max_table_size_to_drop = 0' ]]; then
  exit 1
fi
if [[ ${ECHO_TEST_SCENARIO:-} == alter_failure \
  && $query == 'ALTER TABLE system.query_log MODIFY TTL event_date + INTERVAL 7 DAY DELETE SETTINGS materialize_ttl_after_modify = 0' ]]; then
  exit 1
fi
MOCK
}

run_command() {
  local scenario=$1
  shift
  set +e
  PATH="$fake_bin:/usr/bin:/bin" \
  ECHO_ANALYTICS_INSTANCE_FILE="$instance_file" \
  ECHO_ANALYTICS_CLICKHOUSE_SECRETS_FILE="$secrets_file" \
  ECHO_CLICKHOUSE_CONFIG_DIR="$config_dir" \
  ECHO_CLICKHOUSE_SERVER_CONFIG_FILE="$server_config" \
  ECHO_CLICKHOUSE_SYSTEM_LOG_HEALTH_ATTEMPTS=1 \
  ECHO_CLICKHOUSE_SYSTEM_LOG_HEALTH_INTERVAL_SECONDS=0 \
  ECHO_TEST_OPERATIONS="$operations" \
  ECHO_TEST_SCENARIO="$scenario" \
  ECHO_TEST_STATE="$state_dir" \
    "$COMMAND" "$@" >"$case_dir/stdout" 2>"$case_dir/stderr"
  command_status=$?
  set -e
}

assert_success() {
  [[ $command_status -eq 0 ]] || {
    cat "$case_dir/stderr" >&2
    return 1
  }
}

assert_failure() {
  [[ $command_status -ne 0 ]] || {
    printf 'command unexpectedly succeeded\n' >&2
    return 1
  }
}

assert_not_logged() {
  local pattern=$1
  if grep -q "$pattern" "$operations"; then
    printf 'unexpected operation matching %s\n' "$pattern" >&2
    return 1
  fi
}

test_check_mode() {
  setup_case
  run_command healthy --check
  assert_success
  grep -q 'server level:   information' "$case_dir/stdout"
  grep -q 'system.text_log: rows=0 size=0.00 B ttl=3d' "$case_dir/stdout"
  assert_not_logged '^sudo '
  assert_not_logged '^TRUNCATE TABLE '
  assert_not_logged '^ALTER TABLE '

  setup_case
  run_command ttl_drift --check
  assert_failure
  grep -q 'system.query_log: rows=0 size=0.00 B ttl=drift' "$case_dir/stdout"
  assert_not_logged '^sudo '
}

test_confirmation_requirements() {
  local test_case
  local -a arguments
  setup_case
  for test_case in \
    '' \
    '--apply' \
    '--apply --truncate' \
    '--apply --yes' \
    '--truncate --yes' \
    '--check --yes'
  do
    read -r -a arguments <<<"$test_case"
    run_command healthy "${arguments[@]}"
    assert_failure
  done
  [[ ! -s "$operations" ]]
}

test_apply_and_idempotency() {
  local config_file first_hash first_install_count table days
  local parse_line alter_line install_line move_line restart_line truncate_line
  setup_case
  run_command healthy --apply --truncate --yes
  assert_success
  config_file=$config_dir/echo-system-logs.xml
  python3 -c 'import sys, xml.etree.ElementTree as ET; ET.parse(sys.argv[1])' "$config_file"
  grep -q '<level>information</level>' "$config_file"
  grep -q '<ttl>event_date + INTERVAL 3 DAY DELETE</ttl>' "$config_file"
  grep -q '<ttl>event_date + INTERVAL 7 DAY DELETE</ttl>' "$config_file"
  [[ $(grep -c '^TRUNCATE TABLE system\.' "$operations") -eq 4 ]]
  [[ $(grep -c '^ALTER TABLE system\.' "$operations") -eq 4 ]]
  [[ $(grep -c '^SYSTEM FLUSH LOGS$' "$operations") -eq 2 ]]
  for table in text_log query_log trace_log processors_profile_log; do
    grep -q "^TRUNCATE TABLE system.$table SYNC SETTINGS max_table_size_to_drop = 0$" \
      "$operations"
  done
  for table_days in text_log:3 query_log:7 trace_log:1 processors_profile_log:1; do
    table=${table_days%:*}
    days=${table_days#*:}
    grep -q "^ALTER TABLE system.$table MODIFY TTL event_date + INTERVAL $days DAY DELETE SETTINGS materialize_ttl_after_modify = 0$" \
      "$operations"
  done
  parse_line=$(grep -n -m1 ' query_log.ttl$' "$operations" | cut -d: -f1)
  alter_line=$(grep -n -m1 '^ALTER TABLE system.text_log ' "$operations" | cut -d: -f1)
  install_line=$(grep -n -m1 '^sudo install -m 0640 ' "$operations" | cut -d: -f1)
  move_line=$(grep -n -m1 '^sudo mv -f ' "$operations" | cut -d: -f1)
  restart_line=$(grep -n -m1 '^systemctl restart clickhouse-server$' "$operations" | cut -d: -f1)
  truncate_line=$(grep -n -m1 '^TRUNCATE TABLE system.text_log SYNC SETTINGS max_table_size_to_drop = 0$' "$operations" | cut -d: -f1)
  ((parse_line < alter_line))
  ((alter_line < install_line))
  ((install_line < move_line))
  ((move_line < restart_line))
  ((restart_line < truncate_line))
  first_hash=$(sha256sum "$config_file" | awk '{print $1}')
  first_install_count=$(grep -c '^sudo install -m 0640 ' "$operations")

  rm -f -- "$state_dir/restarted"
  run_command healthy --apply --truncate --yes
  assert_success
  [[ $(sha256sum "$config_file" | awk '{print $1}') == "$first_hash" ]]
  [[ $(grep -c '^sudo install -m 0640 ' "$operations") -eq "$first_install_count" ]]
}

test_fail_fast() {
  setup_case
  run_command pre_health_failure --apply --truncate --yes
  assert_failure
  assert_not_logged '^sudo '
  assert_not_logged '^systemctl '
  assert_not_logged '^TRUNCATE TABLE '

  setup_case
  run_command config_parse_failure --apply --truncate --yes
  assert_failure
  assert_not_logged '^sudo install -m 0640 '
  assert_not_logged '^systemctl '
  assert_not_logged '^TRUNCATE TABLE '

  setup_case
  run_command alter_failure --apply --truncate --yes
  assert_failure
  grep -q '^ALTER TABLE system.text_log ' "$operations"
  grep -q '^ALTER TABLE system.query_log ' "$operations"
  assert_not_logged '^ALTER TABLE system.trace_log '
  assert_not_logged '^sudo install -m 0640 '
  assert_not_logged '^systemctl '
  assert_not_logged '^TRUNCATE TABLE '

  setup_case
  run_command post_restart_health_failure --apply --truncate --yes
  assert_failure
  grep -q '^systemctl restart clickhouse-server$' "$operations"
  assert_not_logged '^TRUNCATE TABLE '

  setup_case
  run_command truncate_failure --apply --truncate --yes
  assert_failure
  grep -q '^TRUNCATE TABLE system.text_log SYNC SETTINGS max_table_size_to_drop = 0$' "$operations"
  grep -q '^TRUNCATE TABLE system.query_log SYNC SETTINGS max_table_size_to_drop = 0$' "$operations"
  assert_not_logged '^TRUNCATE TABLE system.trace_log SYNC SETTINGS max_table_size_to_drop = 0$'
}

test_check_mode
test_confirmation_requirements
test_apply_and_idempotency
test_fail_fast
printf 'ClickHouse system-log maintenance command tests passed\n'
