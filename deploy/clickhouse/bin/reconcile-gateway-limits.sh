#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config
validate_runtime_identifiers

check_only=false
case ${1:-} in
  '') ;;
  --check) check_only=true ;;
  *) die "usage: $0 [--check]" ;;
esac

user_percent=${ANALYTICS_GATEWAY_MEMORY_LIMIT_PERCENT:-50}
query_percent=${ANALYTICS_GATEWAY_QUERY_MEMORY_LIMIT_PERCENT:-25}
max_threads=${ANALYTICS_GATEWAY_MAX_THREADS:-4}
max_queries=${ANALYTICS_GATEWAY_MAX_CONCURRENT_QUERIES:-32}
[[ "$user_percent" =~ ^[1-9][0-9]?$ && "$user_percent" -le 75 ]] \
  || die "ANALYTICS_GATEWAY_MEMORY_LIMIT_PERCENT must be between 1 and 75"
[[ "$query_percent" =~ ^(100|[1-9][0-9]?)$ ]] \
  || die "ANALYTICS_GATEWAY_QUERY_MEMORY_LIMIT_PERCENT must be between 1 and 100"
[[ "$max_threads" =~ ^[1-9][0-9]?$ ]] \
  || die "ANALYTICS_GATEWAY_MAX_THREADS must be between 1 and 99"
[[ "$max_queries" =~ ^[1-9][0-9]?$ ]] \
  || die "ANALYTICS_GATEWAY_MAX_CONCURRENT_QUERIES must be between 1 and 99"

server_limit=$(clickhouse_memory_limit_bytes)
user_limit=$((server_limit * user_percent / 100))
query_limit=$((user_limit * query_percent / 100))
((query_limit > 0)) || die "gateway query memory limit must be positive"

limits_match() {
  local configured_count
  configured_count=$(clickhouse_admin --query "
SELECT count()
FROM system.settings_profile_elements
WHERE user_name = '$CLICKHOUSE_GATEWAY_USER'
  AND min = '1'
  AND (
    (setting_name = 'max_memory_usage' AND value = '$query_limit' AND max = '$query_limit')
    OR (setting_name = 'max_memory_usage_for_user' AND value = '$user_limit' AND max = '$user_limit')
    OR (setting_name = 'max_threads' AND value = '$max_threads' AND max = '$max_threads')
    OR (setting_name = 'max_concurrent_queries_for_user' AND value = '$max_queries' AND max = '$max_queries')
  )
FORMAT TSVRaw
") || die "could not read ClickHouse gateway resource limits"
  [[ "$configured_count" == 4 ]]
}

if $check_only; then
  limits_match || die "ClickHouse gateway resource limits are not reconciled"
  exit 0
fi

if ! limits_match; then
  clickhouse_admin --query "
ALTER USER $CLICKHOUSE_GATEWAY_USER SETTINGS
  max_memory_usage = $query_limit MIN 1 MAX $query_limit,
  max_memory_usage_for_user = $user_limit MIN 1 MAX $user_limit,
  max_threads = $max_threads MIN 1 MAX $max_threads,
  max_concurrent_queries_for_user = $max_queries MIN 1 MAX $max_queries
"
fi
limits_match || die "failed to reconcile ClickHouse gateway resource limits"
log "ClickHouse gateway limits: query=$query_limit user=$user_limit threads=$max_threads concurrent=$max_queries"
