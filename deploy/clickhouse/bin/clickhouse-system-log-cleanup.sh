#!/usr/bin/env bash

validate_clickhouse_system_log_inventory() {
  local table valid
  for table in "${CLICKHOUSE_SYSTEM_LOG_EXISTING_TABLES[@]}"; do
    valid=$(clickhouse_admin --query "
SELECT count() FROM system.columns
WHERE database = 'system' AND table = '$table' AND name = 'event_date' AND type = 'Date'
FORMAT TSVRaw")
    [[ "$valid" == 1 ]] || die "system.$table must have an event_date Date column"
  done
}

validate_merged_clickhouse_system_log_config() {
  local candidate table engine status=0
  candidate=$(mktemp -d /tmp/echo-clickhouse-merged.XXXXXX)
  sudo cp -p "$CLICKHOUSE_SERVER_CONFIG_FILE" "$candidate/config.xml"
  sudo cp -a "$CLICKHOUSE_SYSTEM_LOG_CONFIG_DIR" "$candidate/config.d"
  render_clickhouse_system_log_config | sudo tee "$candidate/config.d/$(basename "$CLICKHOUSE_SYSTEM_LOG_CONFIG_FILE")" >/dev/null
  validate_clickhouse_system_log_config "$candidate/config.xml" || status=$?
  for table in "${CLICKHOUSE_SYSTEM_LOG_ACTIVE_TABLES[@]}"; do
    if engine=$(clickhouse_config_value "$candidate/config.xml" "$table.engine" 2>/dev/null) && [[ -n "$engine" ]]; then
      printf 'Custom engine configuration for %s requires manual TTL reconciliation\n' "$table" >&2
      status=1
    fi
  done
  sudo rm -rf -- "$candidate"
  ((status == 0)) || die "merged ClickHouse system-log configuration is invalid"
}

backup_clickhouse_system_log_policy() {
  local directory table
  directory=${ECHO_CLICKHOUSE_SYSTEM_LOG_BACKUP_DIR:-/var/backups/echo-clickhouse-system-logs/$(date -u +%Y%m%dT%H%M%SZ)-$$}
  sudo install -d -m 0700 "$directory"
  sudo cp -p "$CLICKHOUSE_SERVER_CONFIG_FILE" "$directory/config.xml"
  sudo cp -a "$CLICKHOUSE_SYSTEM_LOG_CONFIG_DIR" "$directory/config.d"
  for table in "${CLICKHOUSE_SYSTEM_LOG_EXISTING_TABLES[@]}"; do
    clickhouse_admin --query "SHOW CREATE TABLE system.$table FORMAT TSVRaw" \
      | sudo tee "$directory/$table.sql" >/dev/null
  done
  log "Saved configuration and diagnostic table definitions to $directory"
}

verify_clickhouse_system_log_identities() {
  local table uuid
  for table in "${CLICKHOUSE_SYSTEM_LOG_EXISTING_TABLES[@]}"; do
    uuid=$(clickhouse_admin --query "
SELECT toString(uuid) FROM system.tables
WHERE database = 'system' AND name = '$table' FORMAT TSVRaw")
    [[ "$uuid" == "${CLICKHOUSE_SYSTEM_LOG_UUIDS[$table]}" ]] \
      || die "system.$table changed identity; inspect archived tables before cleanup"
  done
}

clickhouse_system_log_partitions() {
  local table=$1 date=$2 base days
  base=$(clickhouse_system_log_base "$table") || die "unmanaged diagnostic table: $table"
  days=${CLICKHOUSE_SYSTEM_LOG_TTL_DAYS[$base]}
  clickhouse_admin --max_threads=2 --query "
SELECT _partition_id,
  max(event_date) <= toDate('$date') - INTERVAL $days DAY,
  min(event_date) <= toDate('$date') - INTERVAL $days DAY
FROM system.$table GROUP BY _partition_id ORDER BY _partition_id FORMAT TSVRaw"
}

clickhouse_system_log_partition_is_closed() {
  local table=$1 partition=$2 retention_date=$3 base cutoff partition_key
  base=$(clickhouse_system_log_base "$table") || return 1
  [[ "$table" == "$base" ]] || return 0
  cutoff=$(date -u -d "$retention_date - ${CLICKHOUSE_SYSTEM_LOG_TTL_DAYS[$base]} days" +%Y%m%d)
  partition_key=$(clickhouse_admin --query "SELECT partition_key FROM system.tables WHERE database = 'system' AND name = '$table' FORMAT TSVRaw") || return 1
  if [[ "$partition_key" == 'toYYYYMM(event_date)' && "$partition" =~ ^[0-9]{6}$ ]]; then
    [[ "$partition" < "${cutoff:0:6}" ]]
  elif [[ "$partition_key" == event_date && "$partition" =~ ^[0-9]{8}$ ]]; then
    [[ "$partition" < "$cutoff" || "$partition" == "$cutoff" ]]
  else
    return 1
  fi
}

expire_clickhouse_system_log_table() {
  local table=$1 date=$2 partitions partition expired contains_expired base all_expired=true
  base=$(clickhouse_system_log_base "$table") || die "unmanaged diagnostic table: $table"
  partitions=$(clickhouse_system_log_partitions "$table" "$date") || return 1
  while IFS=$'\t' read -r partition expired contains_expired; do
    [[ -n "$partition" ]] || continue
    [[ "$partition" =~ ^[a-zA-Z0-9_-]+$ && "$expired" =~ ^[01]$ && "$contains_expired" =~ ^[01]$ ]] \
      || die "unexpected diagnostic partition state for system.$table"
    [[ "$expired" == 1 ]] || all_expired=false
  done <<<"$partitions"
  if [[ "$table" != "$base" ]] && $all_expired; then
    log "Dropping expired diagnostic archive system.$table"
    clickhouse_admin --query "DROP TABLE system.$table SYNC SETTINGS max_table_size_to_drop = 0"
    return
  fi
  while IFS=$'\t' read -r partition expired contains_expired; do
    [[ -n "$partition" ]] || continue
    # An active partition can receive retained rows after the inventory query.
    if [[ "$expired" == 1 ]] && clickhouse_system_log_partition_is_closed "$table" "$partition" "$date"; then
      log "Dropping expired diagnostic partition system.$table/$partition"
      clickhouse_admin --query "ALTER TABLE system.$table DROP PARTITION ID '$partition' SETTINGS max_partition_size_to_drop = 0"
    elif [[ "$contains_expired" == 1 ]]; then
      log "Expiring old rows in system.$table/$partition; waiting for TTL materialization"
      clickhouse_admin --query "ALTER TABLE system.$table MATERIALIZE TTL IN PARTITION ID '$partition' SETTINGS mutations_sync = 1"
    fi
  done <<<"$partitions"
}

expire_clickhouse_system_logs() {
  local table date pending
  date=$(clickhouse_admin --query 'SELECT toString(today()) FORMAT TSVRaw')
  [[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "invalid ClickHouse retention date"
  verify_clickhouse_system_log_identities
  for table in "${CLICKHOUSE_SYSTEM_LOG_EXISTING_TABLES[@]}"; do
    pending=$(clickhouse_admin --query "
SELECT count() FROM system.mutations
WHERE database = 'system' AND table = '$table' AND NOT is_done FORMAT TSVRaw")
    [[ "$pending" == 0 ]] || die "system.$table has unfinished mutations; resolve them before cleanup"
    expire_clickhouse_system_log_table "$table" "$date"
  done
}
