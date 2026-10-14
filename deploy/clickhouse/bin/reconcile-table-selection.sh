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

read_mirror_mappings() {
  local payload response
  payload=$(jq -cn --arg mirror "$MIRROR_NAME" \
    '{flowJobName: $mirror, includeFlowInfo: true, excludeBatches: true}')
  response=$(curl --silent --show-error --fail-with-body \
    --connect-timeout 5 --max-time 30 \
    --header 'Content-Type: application/json' --data "$payload" \
    "http://127.0.0.1:${PEERDB_FLOW_HTTP_PORT:-8113}/v1/mirrors/status")
  jq -ec '.cdcStatus.config.tableMappings | select(type == "array")' \
    <<<"$response" || die "PeerDB did not return its table mappings"
}

apply_mapping_batch() {
  local additional=$1 removed=$2 skip_snapshot=$3 payload response
  pause_mirror
  payload=$(jq -cn \
    --arg mirror "$MIRROR_NAME" \
    --argjson additional "$additional" \
    --argjson removed "$removed" \
    --argjson skip_snapshot "$skip_snapshot" \
    '{flowJobName: $mirror, requestedFlowState: "STATUS_RUNNING",
      flowConfigUpdate: {cdcFlowConfigUpdate: ({
        additionalTables: $additional, removedTables: $removed
      } + if $skip_snapshot then {skipInitialSnapshotForTableAdditions: true} else {} end)}}')
  response=$(curl --silent --show-error --fail-with-body \
    --connect-timeout 5 --max-time 30 \
    --header 'Content-Type: application/json' --data "$payload" \
    "http://127.0.0.1:${PEERDB_FLOW_HTTP_PORT:-8113}/v1/mirrors/state_change")
  [[ -z "$response" || "$response" == '{}' ]] \
    || die "unexpected PeerDB table-edit response: $response"
  wait_for_mirror_status 1
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

  local mappings
  mappings=$(read_mirror_mappings)
  declare -A mapped_source_by_target=() mapped_target_by_source=()
  while IFS=$'\t' read -r source target; do
    [[ -n "$source" ]] || continue
    [[ "$source" =~ ^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$ ]] \
      || die "invalid PeerDB source table: $source"
    validate_identifier destination_table "$target"
    [[ -z "${mapped_source_by_target[$target]:-}" \
      && -z "${mapped_target_by_source[$source]:-}" ]] \
      || die "duplicate PeerDB mapping for $source -> $target"
    [[ "$target" == "$(source_table_target "$source")" ]] \
      || die "unexpected PeerDB destination for $source: $target"
    mapped_source_by_target["$target"]=$source
    mapped_target_by_source["$source"]=$target
  done < <(jq -r '.[] | [.sourceTableIdentifier, .destinationTableIdentifier] | @tsv' <<<"$mappings")

  declare -A raw_lookup=()
  while IFS= read -r target; do
    [[ -n "$target" ]] || continue
    validate_identifier raw_table "$target"
    raw_lookup["$target"]=1
  done < <(
    clickhouse_admin_http \
      "SELECT name FROM system.tables WHERE database = '$CLICKHOUSE_RAW_DB' AND NOT startsWith(name, '_peerdb_') ORDER BY name"
  )

  for target in attachment_document attachment_chunk; do
    if [[ -z "${mapped_source_by_target[$target]:-}" \
      || -z "${raw_lookup[$target]:-}" ]]; then
      invalidate_attachment_search_coverage
      break
    fi
  done

  declare -a added_sources=() added_targets=()
  declare -a removed_sources=() removed_targets=()
  declare -a stale_targets=()
  for target in "${!selected_source_by_target[@]}"; do
    if [[ -n "${mapped_source_by_target[$target]:-}" ]]; then
      [[ -n "${raw_lookup[$target]:-}" ]] \
        || die "mapped raw table $target is missing; recover its targeted resnapshot before reconciling"
      continue
    fi
    [[ -z "${raw_lookup[$target]:-}" ]] \
      || die "unmapped raw table $target already exists; inspect interrupted table repair before reconciling"
    added_sources+=("${selected_source_by_target[$target]}")
    added_targets+=("$target")
  done
  for target in "${!mapped_source_by_target[@]}"; do
    [[ -z "${selected_source_by_target[$target]:-}" ]] || continue
    removed_sources+=("${mapped_source_by_target[$target]}")
    removed_targets+=("$target")
    [[ -n "${raw_lookup[$target]:-}" ]] || stale_targets+=("$target")
  done
  for target in "${!raw_lookup[@]}"; do
    [[ -z "${selected_source_by_target[$target]:-}" ]] || continue
    stale_targets+=("$target")
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
    local additional_json='[]' cdc_only_json='[]' removed_json='[]'
    for index in "${!added_sources[@]}"; do
      if source_table_cdc_only "${added_sources[$index]}"; then
        cdc_only_json=$(append_mapping_json \
          "$cdc_only_json" "${added_sources[$index]}" "${added_targets[$index]}")
      else
        additional_json=$(append_mapping_json \
          "$additional_json" "${added_sources[$index]}" "${added_targets[$index]}")
      fi
    done
    for index in "${!removed_sources[@]}"; do
      removed_json=$(append_mapping_json \
        "$removed_json" "${removed_sources[$index]}" "${removed_targets[$index]}")
    done
    if [[ "$cdc_only_json" != '[]' ]]; then
      require_peerdb_cdc_only_table_additions
    fi
    if [[ "$additional_json" != '[]' || "$removed_json" != '[]' ]]; then
      apply_mapping_batch "$additional_json" "$removed_json" false
    fi
    if [[ "$cdc_only_json" != '[]' ]]; then
      apply_mapping_batch "$cdc_only_json" '[]' true
    fi
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

  local expected_mappings actual_mappings
  expected_mappings=$(
    for source in "${SOURCE_TABLES[@]}"; do
      printf '%s\t%s\n' "$source" "$(source_table_target "$source")"
    done | LC_ALL=C sort
  )
  mappings=$(read_mirror_mappings)
  actual_mappings=$(jq -r '.[] | [.sourceTableIdentifier, .destinationTableIdentifier] | @tsv' <<<"$mappings" | LC_ALL=C sort)
  [[ "$expected_mappings" == "$actual_mappings" ]] \
    || die "PeerDB mappings do not match the requested table selection"

  for target in "${stale_targets[@]}"; do
    clickhouse_admin_http \
      "DROP VIEW IF EXISTS \`$CLICKHOUSE_CURRENT_DB\`.\`$target\`"
    clickhouse_admin_http \
      "DROP TABLE IF EXISTS \`$CLICKHOUSE_RAW_DB\`.\`$target\` SYNC"
  done

  reconcile_analytics_schema_with_retry "$SCRIPT_DIR"

  if [[ -n "${selected_source_by_target[attachment_document]:-}" \
    && -n "${selected_source_by_target[attachment_chunk]:-}" ]]; then
    ensure_attachment_search_coverage_table
    if [[ $(postgres_psql --dbname "$GATEWAY_DB" -Atq -v ON_ERROR_STOP=1 \
      -c 'SELECT EXISTS(SELECT 1 FROM public.echo_analytics_attachment_search WHERE singleton)') != t ]]; then
      record_attachment_search_cutover
    fi
  fi

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
