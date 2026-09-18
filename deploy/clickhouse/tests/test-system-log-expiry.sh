#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "$0")" && pwd)
CLICKHOUSE_TEST_BINARY=${CLICKHOUSE_TEST_BINARY:-clickhouse}
case_dir=$(mktemp -d /tmp/echo-system-log-integration.XXXXXX)
server_pid=

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$case_dir"
}
trap cleanup EXIT

port=$(python3 - <<'PY'
import socket
with socket.socket() as connection:
    connection.bind(('127.0.0.1', 0))
    print(connection.getsockname()[1])
PY
)
mkdir -p "$case_dir/data" "$case_dir/config.d"
cat >"$case_dir/config.xml" <<XML
<clickhouse>
  <path>$case_dir/data/</path>
  <logger><level>warning</level><log>$case_dir/server.log</log></logger>
  <listen_host>127.0.0.1</listen_host><tcp_port>$port</tcp_port>
  <max_thread_pool_size>128</max_thread_pool_size>
  <background_pool_size>16</background_pool_size>
  <background_schedule_pool_size>4</background_schedule_pool_size>
  <background_message_broker_schedule_pool_size>2</background_message_broker_schedule_pool_size>
  <background_distributed_schedule_pool_size>2</background_distributed_schedule_pool_size>
  <mark_cache_size>10485760</mark_cache_size>
  <profiles><default><max_threads>2</max_threads></default></profiles>
  <users><default><password></password><networks><ip>127.0.0.1</ip></networks><profile>default</profile><quota>default</quota></default></users>
  <quotas><default/></quotas>
  <text_log><level>trace</level><database>system</database><table>text_log</table></text_log>
  <query_log><database>system</database><table>query_log</table></query_log>
</clickhouse>
XML

# shellcheck source=../bin/lib.sh
source "$TEST_DIR/../bin/lib.sh"
# shellcheck source=../bin/clickhouse-system-log-policy.sh
source "$TEST_DIR/../bin/clickhouse-system-log-policy.sh"
# shellcheck source=../bin/clickhouse-system-log-cleanup.sh
source "$TEST_DIR/../bin/clickhouse-system-log-cleanup.sh"
CLICKHOUSE_SERVER_CONFIG_FILE=$case_dir/config.xml
CLICKHOUSE_SYSTEM_LOG_HEALTH_ATTEMPTS=30
CLICKHOUSE_SYSTEM_LOG_HEALTH_INTERVAL_SECONDS=1
clickhouse_admin() {
  "$CLICKHOUSE_TEST_BINARY" client --host 127.0.0.1 --port "$port" "$@"
}
clickhouse_config_value() {
  "$CLICKHOUSE_TEST_BINARY" extract-from-config --config-file "$1" --key "$2"
}
start_server() {
  "$CLICKHOUSE_TEST_BINARY" server --config-file "$case_dir/config.xml" >"$case_dir/startup.log" 2>&1 &
  server_pid=$!
  if ! (wait_for_authenticated_clickhouse); then
    cat "$case_dir/startup.log" "$case_dir/server.log" >&2
    return 1
  fi
}

start_server
clickhouse_admin --multiquery <<'SQL'
SYSTEM FLUSH LOGS;
CREATE TABLE system.text_log_7 (event_date Date, marker String)
ENGINE = MergeTree PARTITION BY toYYYYMM(event_date) ORDER BY event_date;
INSERT INTO system.text_log_7 VALUES
  (today() - 40, 'old partition'), (today() - 3, 'expired boundary'),
  (today() - 2, 'retained boundary'), (today(), 'recent');
CREATE TABLE system.query_log_12 (event_date Date, marker String)
ENGINE = MergeTree PARTITION BY toYYYYMM(event_date) ORDER BY event_date;
INSERT INTO system.query_log_12 VALUES (today() - 40, 'expired archive');
CREATE DATABASE application;
CREATE TABLE application.text_log (event_date Date, marker String)
ENGINE = MergeTree ORDER BY event_date;
INSERT INTO application.text_log VALUES (today() - 40, 'application history');
SQL
prepare_clickhouse_system_logs
discover_clickhouse_system_logs
validate_clickhouse_system_log_inventory
apply_clickhouse_system_log_ttls
render_clickhouse_system_log_config >"$case_dir/config.d/echo-system-logs.xml"
validate_clickhouse_system_log_config "$case_dir/config.xml"
kill "$server_pid"
wait "$server_pid"
server_pid=
start_server
flush_clickhouse_system_logs
verify_clickhouse_system_log_identities
verify_clickhouse_system_log_policy
expire_clickhouse_system_logs
[[ $(clickhouse_admin --query "SELECT groupArray(marker) FROM (SELECT marker FROM system.text_log_7 ORDER BY marker)") == "['recent','retained boundary']" ]]
[[ $(clickhouse_admin --query 'EXISTS TABLE system.query_log_12') == 0 ]]
[[ $(clickhouse_admin --query 'SELECT count() FROM application.text_log') == 1 ]]
discover_clickhouse_system_logs
expire_clickhouse_system_logs
verify_clickhouse_system_log_policy
[[ $(clickhouse_admin --query 'SELECT count() FROM system.text_log_7') == 2 ]]

# Simulate retained rows arriving in an active partition after its inventory was read.
clickhouse_admin --query "INSERT INTO system.text_log (event_date, event_time, message) VALUES (today(), now(), 'retained-after-inventory')"
(
  clickhouse_system_log_partitions() {
    clickhouse_admin --query "SELECT formatDateTime(today(), '%Y%m'), 1, 1 FORMAT TSVRaw"
  }
  expire_clickhouse_system_log_table text_log "$(clickhouse_admin --query 'SELECT toString(today())')"
)
[[ $(clickhouse_admin --query "SELECT count() FROM system.text_log WHERE message = 'retained-after-inventory'") == 1 ]]

clickhouse_admin --query 'CREATE TABLE system.unknown_log (event_date Date) ENGINE = MergeTree ORDER BY event_date'
if (discover_clickhouse_system_logs); then
  printf 'Unknown diagnostic table was accepted\n' >&2
  exit 1
fi
printf 'ClickHouse expiry, archive, restart, and application-data safeguards passed\n'
