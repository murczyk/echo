#!/usr/bin/env bash

CLICKHOUSE_SYSTEM_LOG_CONFIG_DIR=${ECHO_CLICKHOUSE_CONFIG_DIR:-/etc/clickhouse-server/config.d}
CLICKHOUSE_SYSTEM_LOG_CONFIG_FILE=${ECHO_CLICKHOUSE_SYSTEM_LOG_CONFIG_FILE:-$CLICKHOUSE_SYSTEM_LOG_CONFIG_DIR/echo-system-logs.xml}
CLICKHOUSE_SERVER_CONFIG_FILE=${ECHO_CLICKHOUSE_SERVER_CONFIG_FILE:-/etc/clickhouse-server/config.xml}
CLICKHOUSE_SYSTEM_LOG_HEALTH_ATTEMPTS=${ECHO_CLICKHOUSE_SYSTEM_LOG_HEALTH_ATTEMPTS:-60}
CLICKHOUSE_SYSTEM_LOG_HEALTH_INTERVAL_SECONDS=${ECHO_CLICKHOUSE_SYSTEM_LOG_HEALTH_INTERVAL_SECONDS:-2}
CLICKHOUSE_SYSTEM_LOG_LEVEL=information

declare -ag CLICKHOUSE_SYSTEM_LOG_TABLES=(
  text_log
  query_log
  trace_log
  processors_profile_log
)
declare -Ag CLICKHOUSE_SYSTEM_LOG_TTL_DAYS=(
  [text_log]=3
  [query_log]=7
  [trace_log]=1
  [processors_profile_log]=1
)

render_clickhouse_system_log_config() {
  cat <<XML
<clickhouse>
  <logger>
    <level>$CLICKHOUSE_SYSTEM_LOG_LEVEL</level>
  </logger>
  <text_log>
    <level>$CLICKHOUSE_SYSTEM_LOG_LEVEL</level>
    <ttl>event_date + INTERVAL ${CLICKHOUSE_SYSTEM_LOG_TTL_DAYS[text_log]} DAY DELETE</ttl>
  </text_log>
  <query_log>
    <ttl>event_date + INTERVAL ${CLICKHOUSE_SYSTEM_LOG_TTL_DAYS[query_log]} DAY DELETE</ttl>
  </query_log>
  <trace_log>
    <ttl>event_date + INTERVAL ${CLICKHOUSE_SYSTEM_LOG_TTL_DAYS[trace_log]} DAY DELETE</ttl>
  </trace_log>
  <processors_profile_log>
    <ttl>event_date + INTERVAL ${CLICKHOUSE_SYSTEM_LOG_TTL_DAYS[processors_profile_log]} DAY DELETE</ttl>
  </processors_profile_log>
</clickhouse>
XML
}

clickhouse_config_value() {
  local config_file=$1 key=$2
  clickhouse extract-from-config \
    --config-file "$config_file" \
    --key "$key"
}

validate_clickhouse_system_log_config() {
  local config_file=$1 key expected value
  local -a keys=(
    logger.level
    text_log.level
    text_log.ttl
    query_log.ttl
    trace_log.ttl
    processors_profile_log.ttl
  )
  local -a expected_values=(
    "$CLICKHOUSE_SYSTEM_LOG_LEVEL"
    "$CLICKHOUSE_SYSTEM_LOG_LEVEL"
    "event_date + INTERVAL ${CLICKHOUSE_SYSTEM_LOG_TTL_DAYS[text_log]} DAY DELETE"
    "event_date + INTERVAL ${CLICKHOUSE_SYSTEM_LOG_TTL_DAYS[query_log]} DAY DELETE"
    "event_date + INTERVAL ${CLICKHOUSE_SYSTEM_LOG_TTL_DAYS[trace_log]} DAY DELETE"
    "event_date + INTERVAL ${CLICKHOUSE_SYSTEM_LOG_TTL_DAYS[processors_profile_log]} DAY DELETE"
  )

  for key_index in "${!keys[@]}"; do
    key=${keys[$key_index]}
    expected=${expected_values[$key_index]}
    value=$(clickhouse_config_value "$config_file" "$key") || return 1
    [[ "$value" == "$expected" ]] || return 1
  done
}

validate_rendered_clickhouse_system_log_config() {
  local candidate
  candidate=$(mktemp /tmp/echo-clickhouse-system-logs.XXXXXX)
  render_clickhouse_system_log_config >"$candidate"
  if ! validate_clickhouse_system_log_config "$candidate"; then
    rm -f -- "$candidate"
    die "generated ClickHouse system-log configuration is invalid"
  fi
  rm -f -- "$candidate"
}

install_clickhouse_system_log_config() {
  local candidate installed_candidate
  candidate=$(mktemp /tmp/echo-clickhouse-system-logs.XXXXXX)
  installed_candidate="${CLICKHOUSE_SYSTEM_LOG_CONFIG_FILE}.tmp.$$"
  render_clickhouse_system_log_config >"$candidate"
  if ! validate_clickhouse_system_log_config "$candidate"; then
    rm -f -- "$candidate"
    die "generated ClickHouse system-log configuration is invalid"
  fi

  sudo install -d -m 0755 "$CLICKHOUSE_SYSTEM_LOG_CONFIG_DIR"
  if sudo test -f "$CLICKHOUSE_SYSTEM_LOG_CONFIG_FILE" \
    && sudo cmp -s "$candidate" "$CLICKHOUSE_SYSTEM_LOG_CONFIG_FILE"; then
    rm -f -- "$candidate"
    log "ClickHouse system-log configuration is already current"
    return 0
  fi

  if ! sudo install -m 0640 "$candidate" "$installed_candidate"; then
    rm -f -- "$candidate"
    die "failed to stage ClickHouse system-log configuration"
  fi
  if ! sudo chown root:clickhouse "$installed_candidate" \
    || ! sudo mv -f "$installed_candidate" "$CLICKHOUSE_SYSTEM_LOG_CONFIG_FILE"; then
    sudo rm -f -- "$installed_candidate"
    rm -f -- "$candidate"
    die "failed to install ClickHouse system-log configuration"
  fi
  rm -f -- "$candidate"
  log "Installed $CLICKHOUSE_SYSTEM_LOG_CONFIG_FILE atomically"
}

clickhouse_system_log_ttl_sql() {
  local table=$1 days
  days=${CLICKHOUSE_SYSTEM_LOG_TTL_DAYS[$table]:-}
  [[ -n "$days" ]] || die "unknown ClickHouse system-log table: $table"
  printf 'ALTER TABLE system.%s MODIFY TTL event_date + INTERVAL %s DAY DELETE SETTINGS materialize_ttl_after_modify = 0' \
    "$table" "$days"
}

apply_clickhouse_system_log_ttls() {
  local table
  for table in "${CLICKHOUSE_SYSTEM_LOG_TABLES[@]}"; do
    clickhouse_admin --query "$(clickhouse_system_log_ttl_sql "$table")"
  done
}

truncate_clickhouse_system_logs() {
  local table
  clickhouse_admin --query 'SYSTEM FLUSH LOGS'
  for table in "${CLICKHOUSE_SYSTEM_LOG_TABLES[@]}"; do
    clickhouse_admin --query \
      "TRUNCATE TABLE system.$table SYNC SETTINGS max_table_size_to_drop = 0"
  done
}

clickhouse_system_log_table_state() {
  local table=$1
  clickhouse_admin --query "
SELECT
  toString(ifNull(total_rows, 0)),
  formatReadableSize(ifNull(total_bytes, 0)),
  engine_full
FROM system.tables
WHERE database = 'system' AND name = '$table'
FORMAT TSVRaw"
}

clickhouse_system_log_ttl_matches() {
  local table=$1 engine=$2 days
  days=${CLICKHOUSE_SYSTEM_LOG_TTL_DAYS[$table]}
  [[ "$engine" == *"TTL event_date + toIntervalDay($days)"* \
    || "$engine" == *"TTL event_date + INTERVAL $days DAY"* ]]
}

effective_clickhouse_logger_level() {
  clickhouse_admin --query "
SELECT value
FROM system.server_settings
WHERE name = 'logger.level'
FORMAT TSVRaw"
}

report_clickhouse_system_log_policy() {
  local server_level text_log_level table state rows size engine ttl_status
  server_level=$(effective_clickhouse_logger_level)
  text_log_level=$(clickhouse_config_value "$CLICKHOUSE_SERVER_CONFIG_FILE" text_log.level)
  printf 'ClickHouse effective logging configuration\n'
  printf '  server level:   %s (expected %s)\n' \
    "$server_level" "$CLICKHOUSE_SYSTEM_LOG_LEVEL"
  printf '  text_log level: %s (expected %s)\n' \
    "$text_log_level" "$CLICKHOUSE_SYSTEM_LOG_LEVEL"
  printf 'ClickHouse diagnostic table retention and size\n'
  for table in "${CLICKHOUSE_SYSTEM_LOG_TABLES[@]}"; do
    state=$(clickhouse_system_log_table_state "$table")
    [[ -n "$state" ]] || die "system.$table does not exist"
    IFS=$'\t' read -r rows size engine <<<"$state"
    ttl_status=drift
    if clickhouse_system_log_ttl_matches "$table" "$engine"; then
      ttl_status="${CLICKHOUSE_SYSTEM_LOG_TTL_DAYS[$table]}d"
    fi
    printf '  system.%s: rows=%s size=%s ttl=%s\n' \
      "$table" "$rows" "$size" "$ttl_status"
    printf '    engine: %s\n' "$engine"
  done
}

verify_clickhouse_system_log_policy() {
  local table state engine
  verify_clickhouse_system_log_levels

  for table in "${CLICKHOUSE_SYSTEM_LOG_TABLES[@]}"; do
    state=$(clickhouse_system_log_table_state "$table")
    [[ -n "$state" ]] || die "system.$table does not exist"
    IFS=$'\t' read -r _ _ engine <<<"$state"
    clickhouse_system_log_ttl_matches "$table" "$engine" \
      || die "system.$table does not have the expected ${CLICKHOUSE_SYSTEM_LOG_TTL_DAYS[$table]}-day TTL"
  done
}

verify_clickhouse_system_log_levels() {
  local server_level text_log_level
  server_level=$(effective_clickhouse_logger_level)
  [[ "$server_level" == "$CLICKHOUSE_SYSTEM_LOG_LEVEL" ]] \
    || die "ClickHouse server log level is $server_level, expected $CLICKHOUSE_SYSTEM_LOG_LEVEL"
  text_log_level=$(clickhouse_config_value "$CLICKHOUSE_SERVER_CONFIG_FILE" text_log.level)
  [[ "$text_log_level" == "$CLICKHOUSE_SYSTEM_LOG_LEVEL" ]] \
    || die "ClickHouse text_log level is $text_log_level, expected $CLICKHOUSE_SYSTEM_LOG_LEVEL"
}

wait_for_authenticated_clickhouse() {
  local attempt
  [[ "$CLICKHOUSE_SYSTEM_LOG_HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] \
    || die "ECHO_CLICKHOUSE_SYSTEM_LOG_HEALTH_ATTEMPTS must be a positive integer"
  [[ "$CLICKHOUSE_SYSTEM_LOG_HEALTH_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] \
    || die "ECHO_CLICKHOUSE_SYSTEM_LOG_HEALTH_INTERVAL_SECONDS must be a non-negative integer"

  for ((attempt = 1; attempt <= CLICKHOUSE_SYSTEM_LOG_HEALTH_ATTEMPTS; attempt++)); do
    if clickhouse_admin --query 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    if ((attempt < CLICKHOUSE_SYSTEM_LOG_HEALTH_ATTEMPTS)); then
      sleep "$CLICKHOUSE_SYSTEM_LOG_HEALTH_INTERVAL_SECONDS"
    fi
  done
  die "authenticated ClickHouse health check failed"
}
