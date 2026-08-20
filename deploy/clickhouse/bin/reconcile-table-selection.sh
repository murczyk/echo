#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config
validate_runtime_identifiers
acquire_analytics_reconcile_lock
require_expected_control_release
require_cmd curl
require_cmd jq

timeout=${MIRROR_TABLE_RECONCILE_TIMEOUT_SECONDS:-7200}
poll_interval=${MIRROR_TABLE_RECONCILE_POLL_SECONDS:-5}
[[ "$timeout" =~ ^[1-9][0-9]*$ ]] \
  || die "MIRROR_TABLE_RECONCILE_TIMEOUT_SECONDS must be a positive integer"
[[ "$poll_interval" =~ ^[1-9][0-9]*$ ]] \
  || die "MIRROR_TABLE_RECONCILE_POLL_SECONDS must be a positive integer"

mirror_status() {
  catalog_psql -Atq \
    -v ON_ERROR_STOP=1 \
    -v mirror="$MIRROR_NAME" <<'SQL'
SELECT status FROM flows WHERE name = :'mirror';
SQL
}

wait_for_mirror_status() {
  local expected=$1 deadline status
  deadline=$((SECONDS + timeout))
  while ((SECONDS < deadline)); do
    status=$(mirror_status 2>/dev/null || true)
    [[ "$status" == "$expected" ]] && return 0
    case $status in
      6|7|8|10)
        die "mirror entered terminal status $status"
        ;;
    esac
    sleep "$poll_interval"
  done
  die "mirror did not reach status $expected within ${timeout}s"
}

pause_mirror() {
  local status
  status=$(mirror_status)
  case $status in
    1)
      peerdb_psql -q -v ON_ERROR_STOP=1 \
        -c "PAUSE MIRROR IF EXISTS $MIRROR_NAME"
      wait_for_mirror_status 2
      ;;
    2)
      ;;
    *)
      die "mirror must be RUNNING or PAUSED before table reconciliation (status=${status:-missing})"
      ;;
  esac
  log "Mirror is paused for table-selection reconciliation"
}

append_mapping_json() {
  local json=$1 source=$2 destination=$3
  jq -c \
    --arg source "$source" \
    --arg destination "$destination" \
    '. + [{sourceTableIdentifier: $source, destinationTableIdentifier: $destination}]' \
    <<<"$json"
}

apply_selection() {
  ensure_yes "${1:-}"
  [[ $(mirror_status) == 2 ]] \
    || die "mirror must be paused before applying a table-selection change"

  read_source_tables
  declare -A selected_source_by_target=()
  local source target previous
  for source in "${SOURCE_TABLES[@]}"; do
    target=$(source_table_target "$source")
    previous=${selected_source_by_target[$target]:-}
    [[ -z "$previous" || "$previous" == "$source" ]] \
      || die "source tables collide at target $target: $previous and $source"
    selected_source_by_target["$target"]=$source
  done

  declare -A all_source_by_target=()
  while IFS= read -r source; do
    [[ -n "$source" ]] || continue
    target=$(source_table_target "$source")
    previous=${all_source_by_target[$target]:-}
    [[ -z "$previous" || "$previous" == "$source" ]] \
      || die "source tables collide at target $target: $previous and $source"
    all_source_by_target["$target"]=$source
  done < <(
    source_psql -Atq -v ON_ERROR_STOP=1 <<'SQL'
SELECT namespace.nspname || '.' || relation.relname
FROM pg_catalog.pg_class relation
JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p')
  AND namespace.nspname <> 'information_schema'
  AND namespace.nspname !~ '^pg_'
ORDER BY namespace.nspname, relation.relname;
SQL
  )

  declare -A raw_lookup=()
  while IFS= read -r target; do
    [[ -n "$target" ]] && raw_lookup["$target"]=1
  done < <(
    clickhouse_admin_http \
      "SELECT name FROM system.tables WHERE database = '$CLICKHOUSE_RAW_DB' AND NOT startsWith(name, '_peerdb_') ORDER BY name"
  )

  declare -a added_sources=() added_targets=()
  declare -a removed_sources=() removed_targets=()
  for target in "${!selected_source_by_target[@]}"; do
    [[ -n "${raw_lookup[$target]:-}" ]] && continue
    added_sources+=("${selected_source_by_target[$target]}")
    added_targets+=("$target")
  done
  for target in "${!raw_lookup[@]}"; do
    [[ -z "${selected_source_by_target[$target]:-}" ]] || continue
    source=${all_source_by_target[$target]:-}
    [[ -n "$source" ]] \
      || die "cannot map stale ClickHouse table $target back to a source table; use a full mirror resync"
    removed_sources+=("$source")
    removed_targets+=("$target")
  done

  log "Table selection changes: add ${#added_sources[@]}, remove ${#removed_sources[@]}"
  if ((${#added_sources[@]} > 0)); then
    for index in "${!added_sources[@]}"; do
      log "  add ${added_sources[$index]} -> ${added_targets[$index]}"
    done
  fi
  if ((${#removed_sources[@]} > 0)); then
    for index in "${!removed_sources[@]}"; do
      log "  remove ${removed_sources[$index]} -> ${removed_targets[$index]}"
    done
  fi

  if ((${#added_sources[@]} > 0 || ${#removed_sources[@]} > 0)); then
    local additional_json='[]' removed_json='[]' payload response
    for index in "${!added_sources[@]}"; do
      additional_json=$(append_mapping_json \
        "$additional_json" "${added_sources[$index]}" "${added_targets[$index]}")
    done
    for index in "${!removed_sources[@]}"; do
      removed_json=$(append_mapping_json \
        "$removed_json" "${removed_sources[$index]}" "${removed_targets[$index]}")
    done
    payload=$(jq -cn \
      --arg mirror "$MIRROR_NAME" \
      --argjson additional "$additional_json" \
      --argjson removed "$removed_json" \
      '{
        flowJobName: $mirror,
        requestedFlowState: "STATUS_RUNNING",
        flowConfigUpdate: {
          cdcFlowConfigUpdate: {
            additionalTables: $additional,
            removedTables: $removed
          }
        }
      }')
    response=$(curl \
      --silent \
      --show-error \
      --fail-with-body \
      --connect-timeout 5 \
      --max-time 30 \
      --header 'Content-Type: application/json' \
      --data "$payload" \
      "http://127.0.0.1:${PEERDB_FLOW_HTTP_PORT:-8113}/v1/mirrors/state_change")
    [[ -z "$response" || "$response" == '{}' ]] \
      || die "unexpected PeerDB table-edit response: $response"
  else
    peerdb_psql -q -v ON_ERROR_STOP=1 \
      -c "RESUME MIRROR IF EXISTS $MIRROR_NAME"
  fi

  wait_for_mirror_status 1

  local deadline missing
  deadline=$((SECONDS + timeout))
  while true; do
    missing=0
    for target in "${added_targets[@]}"; do
      [[ $(clickhouse_admin_http \
        "SELECT count() FROM system.tables WHERE database = '$CLICKHOUSE_RAW_DB' AND name = '$target'") == 1 ]] \
        || missing=$((missing + 1))
    done
    ((missing == 0)) && break
    ((SECONDS < deadline)) \
      || die "$missing newly selected ClickHouse tables did not appear within ${timeout}s"
    sleep "$poll_interval"
  done

  for target in "${removed_targets[@]}"; do
    clickhouse_admin_http \
      "DROP VIEW IF EXISTS \`$CLICKHOUSE_CURRENT_DB\`.\`$target\`"
    clickhouse_admin_http \
      "DROP TABLE IF EXISTS \`$CLICKHOUSE_RAW_DB\`.\`$target\` SYNC"
  done

  "$SCRIPT_DIR/refresh-current-views.sh"
  "$SCRIPT_DIR/refresh-gateway.sh"
  "$SCRIPT_DIR/reconcile-schema.sh"
  "$SCRIPT_DIR/check-analytics-health.sh"
  log "Mirror table selection is reconciled"
}

case ${1:-} in
  --pause)
    pause_mirror
    ;;
  --yes)
    apply_selection --yes
    ;;
  *)
    die "usage: $0 --pause|--yes"
    ;;
esac
