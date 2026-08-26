#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ANALYTICS_LIB=${ECHO_ANALYTICS_LIB:-$SCRIPT_DIR/lib.sh}
# shellcheck disable=SC1090,SC1091
source "$ANALYTICS_LIB"

table_resnapshot_timeout=${MIRROR_TABLE_RESNAPSHOT_TIMEOUT_SECONDS:-7200}
table_resnapshot_poll_interval=${MIRROR_TABLE_RESNAPSHOT_POLL_SECONDS:-5}
table_resnapshot_state_dir=${ECHO_ANALYTICS_RESNAPSHOT_STATE_DIR:-/var/lib/echo-analytics/table-resnapshot}
analytics_bin_dir=${ECHO_ANALYTICS_BIN_DIR:-$(dirname "$ANALYTICS_LIB")}
mutation_started=false
repair_complete=false

mirror_status() {
  catalog_psql -Atq \
    -v ON_ERROR_STOP=1 \
    -v mirror="$MIRROR_NAME" <<'SQL'
SELECT status FROM flows WHERE name = :'mirror';
SQL
}

peerdb_api() {
  local endpoint=$1 payload=$2

  curl \
    --silent \
    --show-error \
    --fail-with-body \
    --connect-timeout 5 \
    --max-time 60 \
    --header 'Content-Type: application/json' \
    --data "$payload" \
    "http://127.0.0.1:${PEERDB_FLOW_HTTP_PORT:-8113}/v1/mirrors/$endpoint"
}

mirror_info() {
  local payload
  payload=$(jq -cn \
    --arg mirror "$MIRROR_NAME" \
    '{flowJobName: $mirror, includeFlowInfo: true, excludeBatches: true}')
  peerdb_api status "$payload"
}

current_mapping_json() {
  local source_table=$1 info count
  info=$(mirror_info)
  count=$(jq -r \
    --arg table "$source_table" \
    '[.cdcStatus.config.tableMappings[]? | select(.sourceTableIdentifier == $table)] | length' \
    <<<"$info")
  [[ "$count" =~ ^[0-9]+$ ]] || die "PeerDB returned an invalid table mapping count"
  ((count <= 1)) || die "PeerDB has duplicate mappings for $source_table"
  ((count == 1)) || return 0
  jq -c \
    --arg table "$source_table" \
    '.cdcStatus.config.tableMappings[] | select(.sourceTableIdentifier == $table)' \
    <<<"$info"
}

wait_for_mirror_status() {
  local expected=$1 deadline status
  deadline=$((SECONDS + table_resnapshot_timeout))
  while ((SECONDS < deadline)); do
    status=$(mirror_status 2>/dev/null || true)
    [[ "$status" == "$expected" ]] && return 0
    case $status in
      6|7|8|10)
        die "mirror entered terminal status $status"
        ;;
    esac
    sleep "$table_resnapshot_poll_interval"
  done
  die "mirror did not reach status $expected within ${table_resnapshot_timeout}s"
}

stable_mirror_status() {
  local deadline status
  deadline=$((SECONDS + table_resnapshot_timeout))
  while ((SECONDS < deadline)); do
    status=$(mirror_status 2>/dev/null || true)
    case $status in
      1|2)
        printf '%s' "$status"
        return 0
        ;;
      6|7|8|10)
        die "mirror is in terminal status $status"
        ;;
    esac
    sleep "$table_resnapshot_poll_interval"
  done
  die "mirror did not reach a stable state within ${table_resnapshot_timeout}s"
}

change_mirror_state() {
  local requested_state=$1 payload response
  payload=$(jq -cn \
    --arg mirror "$MIRROR_NAME" \
    --arg state "$requested_state" \
    '{flowJobName: $mirror, requestedFlowState: $state}')
  response=$(peerdb_api state_change "$payload")
  jq -e 'type == "object" and length == 0' <<<"$response" >/dev/null \
    || die "unexpected PeerDB state-change response: $response"
}

pause_mirror() {
  local status
  status=$(stable_mirror_status)
  case $status in
    1)
      change_mirror_state STATUS_PAUSED
      wait_for_mirror_status 2
      ;;
    2)
      ;;
  esac
  log "Mirror is paused for the targeted table resnapshot"
}

resume_mirror() {
  local status
  status=$(stable_mirror_status)
  case $status in
    1)
      ;;
    2)
      change_mirror_state STATUS_RUNNING
      wait_for_mirror_status 1
      ;;
  esac
}

apply_table_edit() {
  local action=$1 mapping=$2 payload response
  [[ $(stable_mirror_status) == 2 ]] \
    || die "mirror must be paused before editing a table mapping"
  case $action in
    add)
      payload=$(jq -cn \
        --arg mirror "$MIRROR_NAME" \
        --argjson mapping "$mapping" \
        '{
          flowJobName: $mirror,
          requestedFlowState: "STATUS_RUNNING",
          flowConfigUpdate: {
            cdcFlowConfigUpdate: {
              additionalTables: [$mapping]
            }
          }
        }')
      ;;
    remove)
      payload=$(jq -cn \
        --arg mirror "$MIRROR_NAME" \
        --argjson mapping "$mapping" \
        '{
          flowJobName: $mirror,
          requestedFlowState: "STATUS_RUNNING",
          flowConfigUpdate: {
            cdcFlowConfigUpdate: {
              removedTables: [$mapping]
            }
          }
        }')
      ;;
    *)
      die "unsupported table edit: $action"
      ;;
  esac
  response=$(peerdb_api state_change "$payload")
  jq -e 'type == "object" and length == 0' <<<"$response" >/dev/null \
    || die "unexpected PeerDB table-edit response: $response"
  wait_for_mirror_status 1
}

source_table_selected() {
  local source_table=$1 schema relation selected
  schema=${source_table%%.*}
  relation=${source_table##*.}
  selected=$(source_psql -Atq \
    -v ON_ERROR_STOP=1 \
    -v publication="$SOURCE_PUBLICATION" \
    -v source_schema="$schema" \
    -v source_table="$relation" <<'SQL'
SELECT count(*)
FROM pg_catalog.pg_publication_tables
WHERE pubname = :'publication'
  AND schemaname = :'source_schema'
  AND tablename = :'source_table';
SQL
  )
  [[ "$selected" == 1 ]]
}

source_table_has_rows() {
  local source_table=$1 has_rows
  has_rows=$(source_psql -Atq -v ON_ERROR_STOP=1 \
    -c "SELECT EXISTS (SELECT 1 FROM $source_table LIMIT 1)")
  [[ "$has_rows" == t ]]
}

source_columns() {
  local source_table=$1 schema relation
  schema=${source_table%%.*}
  relation=${source_table##*.}
  source_psql -Atq \
    -v ON_ERROR_STOP=1 \
    -v source_schema="$schema" \
    -v source_table="$relation" <<'SQL'
SELECT attribute.attname
FROM pg_catalog.pg_class relation
JOIN pg_catalog.pg_namespace namespace
  ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_attribute attribute
  ON attribute.attrelid = relation.oid
 AND attribute.attnum > 0
 AND NOT attribute.attisdropped
WHERE namespace.nspname = :'source_schema'
  AND relation.relname = :'source_table'
  AND relation.relkind IN ('r', 'p')
ORDER BY attribute.attname;
SQL
}

raw_columns() {
  local target=$1
  clickhouse_admin_http "
    SELECT name
    FROM system.columns
    WHERE database = '$CLICKHOUSE_RAW_DB'
      AND table = '$target'
      AND name NOT IN ('_peerdb_is_deleted', '_peerdb_synced_at', '_peerdb_version')
    ORDER BY name
  "
}

raw_table_exists() {
  local target=$1
  [[ $(clickhouse_admin_http "
    SELECT count()
    FROM system.tables
    WHERE database = '$CLICKHOUSE_RAW_DB'
      AND name = '$target'
  ") == 1 ]]
}

validate_mapping() {
  local source_table=$1 mapping=$2 destination
  jq -e \
    --arg table "$source_table" \
    'type == "object"
      and .sourceTableIdentifier == $table
      and ((.destinationTableIdentifier | type) == "string")
      and ((.destinationTableIdentifier | length) > 0)
      and ((keys - [
        "sourceTableIdentifier",
        "destinationTableIdentifier",
        "partitionKey",
        "exclude",
        "columns",
        "engine",
        "shardingKey",
        "policyName",
        "partitionByExpr"
      ]) | length == 0)
      and ((.partitionKey // "") == "")
      and ((.exclude // []) | length == 0)
      and ((.columns // []) | length == 0)
      and ((.engine // "CH_ENGINE_REPLACING_MERGE_TREE") as $engine
        | $engine == 0 or $engine == "CH_ENGINE_REPLACING_MERGE_TREE")
      and ((.shardingKey // "") == "")
      and ((.policyName // "") == "")
      and ((.partitionByExpr // "") == "")' \
    <<<"$mapping" >/dev/null \
    || die "PeerDB mapping for $source_table uses unsupported transforms"
  destination=$(jq -r '.destinationTableIdentifier' <<<"$mapping")
  validate_identifier destination_table "$destination"
}

mapping_destination() {
  jq -r '.destinationTableIdentifier' <<<"$1"
}

canonical_mapping() {
  jq -Sc . <<<"$1"
}

mappings_equal() {
  local first second
  first=$(canonical_mapping "$1")
  second=$(canonical_mapping "$2")
  [[ "$first" == "$second" ]]
}

state_file_for_table() {
  local source_table=$1
  printf '%s/%s-%s.json' \
    "$table_resnapshot_state_dir" "$MIRROR_NAME" "${source_table//./__}"
}

ensure_state_dir() {
  install -d -o root -g root -m 0700 "$table_resnapshot_state_dir"
}

read_state_mapping() {
  local source_table=$1 state_file
  state_file=$(state_file_for_table "$source_table")
  [[ -f "$state_file" ]] || return 0
  jq -ec \
    --arg table "$source_table" \
    'select(.sourceTableIdentifier == $table) | .mapping' \
    "$state_file" \
    || die "invalid targeted resnapshot state: $state_file"
}

read_state_strategy() {
  local source_table=$1 state_file
  state_file=$(state_file_for_table "$source_table")
  [[ -f "$state_file" ]] || return 0
  jq -er \
    '.strategy // "empty_table_resnapshot"' \
    "$state_file" \
    || die "invalid targeted resnapshot state: $state_file"
}

write_state_mapping() {
  local source_table=$1 strategy=$2 mapping=$3 state_file temporary_file
  ensure_state_dir
  state_file=$(state_file_for_table "$source_table")
  temporary_file=$(mktemp "$table_resnapshot_state_dir/.table-resnapshot.XXXXXX")
  jq -cn \
    --arg table "$source_table" \
    --arg strategy "$strategy" \
    --argjson mapping "$mapping" \
    '{sourceTableIdentifier: $table, strategy: $strategy, mapping: $mapping}' \
    >"$temporary_file"
  chmod 0600 "$temporary_file"
  mv -f -- "$temporary_file" "$state_file"
}

clear_state_mapping() {
  rm -f -- "$(state_file_for_table "$1")"
}

drop_raw_table_and_view() {
  local destination=$1
  clickhouse_admin_http \
    "DROP VIEW IF EXISTS \`$CLICKHOUSE_CURRENT_DB\`.\`$destination\`"
  clickhouse_admin_http \
    "DROP TABLE IF EXISTS \`$CLICKHOUSE_RAW_DB\`.\`$destination\` SYNC"
}

wait_for_table_snapshot() {
  local source_table=$1 expected_mapping=$2 destination=$3
  local deadline status mapping source_schema raw_schema raw_only
  deadline=$((SECONDS + table_resnapshot_timeout))
  while ((SECONDS < deadline)); do
    status=$(mirror_status 2>/dev/null || true)
    case $status in
      1)
        if raw_table_exists "$destination"; then
          mapping=$(current_mapping_json "$source_table")
          if [[ -n "$mapping" ]] \
            && mappings_equal "$mapping" "$expected_mapping"
          then
            source_schema=$(source_columns "$source_table" | LC_ALL=C sort)
            raw_schema=$(raw_columns "$destination" | LC_ALL=C sort)
            raw_only=$(comm -13 \
              <(printf '%s\n' "$source_schema") \
              <(printf '%s\n' "$raw_schema"))
            [[ -z "$raw_only" ]] \
              || die "raw ClickHouse gained unexpected columns during the snapshot: $raw_only"
            [[ "$source_schema" == "$raw_schema" ]] && return 0
          fi
        fi
        ;;
      6|7|8|10)
        die "mirror entered terminal status $status during the table snapshot"
        ;;
    esac
    sleep "$table_resnapshot_poll_interval"
  done
  die "$source_table did not finish its targeted snapshot within ${table_resnapshot_timeout}s"
}

refresh_analytics() {
  "$analytics_bin_dir/refresh-current-views.sh"
  "$analytics_bin_dir/refresh-gateway.sh"
  "$analytics_bin_dir/reconcile-schema.sh"
  "$analytics_bin_dir/check-analytics-health.sh"
}

finish_repair() {
  local source_table=$1
  resume_mirror
  refresh_analytics
  clear_state_mapping "$source_table"
  repair_complete=true
  log "Targeted table resnapshot completed for $source_table"
}

resnapshot_table() {
  local strategy=$1 source_table=$2 current_mapping state_mapping
  local state_strategy mapping destination
  local source_schema raw_schema source_only raw_only
  local raw_exists=false

  source_table_selected "$source_table" \
    || die "$source_table is not selected in publication $SOURCE_PUBLICATION"
  stable_mirror_status >/dev/null
  current_mapping=$(current_mapping_json "$source_table")
  state_mapping=$(read_state_mapping "$source_table")
  state_strategy=$(read_state_strategy "$source_table")
  [[ -n "$current_mapping" || -n "$state_mapping" ]] \
    || die "$source_table is not mapped in mirror $MIRROR_NAME"
  if [[ -n "$state_strategy" && "$state_strategy" != "$strategy" ]]; then
    die "the requested strategy for $source_table differs from the preserved retry state"
  fi

  if [[ -n "$current_mapping" && -n "$state_mapping" ]] \
    && ! mappings_equal "$current_mapping" "$state_mapping"
  then
    die "the current mapping for $source_table differs from the preserved retry state"
  fi
  mapping=${state_mapping:-$current_mapping}
  validate_mapping "$source_table" "$mapping"
  destination=$(mapping_destination "$mapping")
  source_schema=$(source_columns "$source_table" | LC_ALL=C sort)
  [[ -n "$source_schema" ]] || die "$source_table has no source columns"

  if raw_table_exists "$destination"; then
    raw_exists=true
    raw_schema=$(raw_columns "$destination" | LC_ALL=C sort)
    raw_only=$(comm -13 \
      <(printf '%s\n' "$source_schema") \
      <(printf '%s\n' "$raw_schema"))
    [[ -z "$raw_only" ]] \
      || die "$CLICKHOUSE_RAW_DB.$destination has raw-only columns: $raw_only"
    source_only=$(comm -23 \
      <(printf '%s\n' "$source_schema") \
      <(printf '%s\n' "$raw_schema"))
  else
    raw_schema=
    source_only=$source_schema
  fi

  if [[ -z "$state_mapping" && -z "$source_only" ]]; then
    log "$source_table already matches raw ClickHouse; no resnapshot needed"
    repair_complete=true
    return 0
  fi
  if [[ -z "$state_mapping" && "$raw_exists" != true ]]; then
    die "$CLICKHOUSE_RAW_DB.$destination is missing without recoverable resnapshot state"
  fi
  if [[ "$strategy" == empty_table_resnapshot ]]; then
    source_table_has_rows "$source_table" \
      && die "$source_table is not empty; refusing empty-table resnapshot"
  fi

  if [[ -z "$state_mapping" ]]; then
    [[ -n "$current_mapping" ]] \
      || die "$source_table mapping disappeared before the repair started"
    write_state_mapping "$source_table" "$strategy" "$mapping"
  fi
  mutation_started=true

  if [[ -n "$current_mapping" && -n "$raw_schema" && -z "$source_only" ]]; then
    finish_repair "$source_table"
    return 0
  fi

  pause_mirror
  if [[ -n "$current_mapping" ]]; then
    log "Removing preserved mapping for $source_table"
    apply_table_edit remove "$mapping"
    pause_mirror
  fi

  log "Dropping only $CLICKHOUSE_RAW_DB.$destination and its current-state view"
  drop_raw_table_and_view "$destination"
  log "Re-adding preserved mapping for $source_table"
  apply_table_edit add "$mapping"
  wait_for_table_snapshot "$source_table" "$mapping" "$destination"
  finish_repair "$source_table"
}

leave_mirror_paused() {
  local deadline status
  deadline=$((SECONDS + table_resnapshot_timeout))
  while ((SECONDS < deadline)); do
    status=$(mirror_status 2>/dev/null || true)
    case $status in
      1)
        change_mirror_state STATUS_PAUSED >/dev/null 2>&1 || return 1
        wait_for_mirror_status 2 >/dev/null 2>&1
        return $?
        ;;
      2)
        return 0
        ;;
      6|7|8|10)
        return 1
        ;;
    esac
    sleep "$table_resnapshot_poll_interval"
  done
  return 1
}

handle_exit() {
  local exit_status=$?
  trap - EXIT
  if ((exit_status != 0)) && [[ "$mutation_started" == true && "$repair_complete" != true ]]; then
    log "Targeted resnapshot did not complete; attempting to leave the mirror paused"
    leave_mirror_paused \
      || log "Mirror could not be paused; inspect its terminal or transitional state immediately"
  fi
  exit "$exit_status"
}

main() {
  local strategy=${2:-} source_table=${3:-}
  [[ ${1:-} == --strategy && -n "$strategy" && -n "$source_table" && $# -eq 3 ]] \
    || die "usage: $0 --strategy empty_table_resnapshot|replicated_snapshot SCHEMA.TABLE"
  [[ "$strategy" == empty_table_resnapshot || "$strategy" == replicated_snapshot ]] \
    || die "invalid resnapshot strategy: $strategy"
  [[ "$source_table" =~ ^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$ ]] \
    || die "invalid source table: $source_table"
  [[ "$table_resnapshot_timeout" =~ ^[1-9][0-9]*$ ]] \
    || die "MIRROR_TABLE_RESNAPSHOT_TIMEOUT_SECONDS must be a positive integer"
  [[ "$table_resnapshot_poll_interval" =~ ^[1-9][0-9]*$ ]] \
    || die "MIRROR_TABLE_RESNAPSHOT_POLL_SECONDS must be a positive integer"

  load_analytics_config
  validate_runtime_identifiers
  acquire_analytics_reconcile_lock
  require_expected_control_release
  require_cmd comm
  require_cmd curl
  require_cmd jq
  require_cmd mktemp

  trap handle_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  resnapshot_table "$strategy" "$source_table"
}

if [[ ${ECHO_ANALYTICS_RESNAPSHOT_TEST_MODE:-false} != true ]]; then
  main "$@"
fi
