#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config
validate_runtime_identifiers

report_minutes=${1:-60}
report_limit=${2:-30}
[[ "$report_minutes" =~ ^[1-9][0-9]*$ ]] \
  || die "report window must be a positive number of minutes"
[[ "$report_limit" =~ ^[1-9][0-9]*$ ]] \
  || die "report limit must be a positive integer"

log "Gateway parent queries since the last pg_stat_statements reset"
postgres_psql \
  --dbname "$GATEWAY_DB" \
  -v ON_ERROR_STOP=1 \
  -v report_limit="$report_limit" <<'SQL'
SELECT stats_reset
FROM pg_stat_statements_info;

SELECT
  queryid,
  calls,
  round(total_exec_time::numeric / 1000, 2) AS total_seconds,
  round(mean_exec_time::numeric, 2) AS mean_ms,
  round(max_exec_time::numeric, 2) AS max_ms,
  rows,
  shared_blks_hit,
  shared_blks_read,
  temp_blks_written,
  left(regexp_replace(query, E'[\n\r\t ]+', ' ', 'g'), 500) AS normalized_query
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND query NOT LIKE '%pg_stat_statements%'
ORDER BY total_exec_time DESC
LIMIT :'report_limit';
SQL

log "ClickHouse query fragments from the last $report_minutes minutes"
clickhouse_admin --format PrettyCompactMonoBlock --query "
WITH
  toUInt64($report_minutes) AS window_minutes,
  aggregated AS
  (
    SELECT
      normalized_query_hash,
      count() AS calls,
      sum(query_duration_ms) AS total_duration_ms,
      avg(query_duration_ms) AS mean_duration_ms,
      quantile(0.95)(query_duration_ms) AS p95_duration_ms,
      max(query_duration_ms) AS max_duration_ms,
      sum(read_rows) AS rows_read,
      max(read_rows) AS max_rows_read,
      sum(result_rows) AS rows_returned,
      max(result_rows) AS max_rows_returned,
      sum(read_bytes) AS bytes_read,
      max(memory_usage) AS peak_memory,
      any(normalizeQuery(query)) AS normalized_query,
      max(
        positionCaseInsensitive(query, 'sigint_inbox_item') > 0
        AND positionCaseInsensitive(query, 'signal_message') > 0
        AND (
          positionCaseInsensitive(query, ' BETWEEN ') > 0
          OR positionCaseInsensitive(query, ' >= ') > 0
        )
      ) AS is_bounded_facet
    FROM system.query_log
    WHERE type = 'QueryFinish'
      AND event_time >= now() - toIntervalMinute(window_minutes)
      AND query_kind = 'Select'
      AND positionCaseInsensitive(query, 'system.query_log') = 0
    GROUP BY normalized_query_hash
  )
SELECT
  arrayStringConcat(
    arrayFilter(flag -> flag != '', [
      if(calls / window_minutes > 100, 'REMOTE_CALLS_GT_100_PER_MIN', ''),
      if(max_rows_returned > 100000, 'INTERMEDIATE_ROWS_GT_100K', ''),
      if(
        is_bounded_facet AND max_rows_read > 10000000,
        'BOUNDED_READ_ROWS_GT_10M',
        ''
      )
    ]),
    ','
  ) AS flags,
  normalized_query_hash AS query_hash,
  calls,
  round(calls / window_minutes, 2) AS calls_per_minute,
  round(total_duration_ms / 1000, 2) AS total_seconds,
  round(mean_duration_ms, 2) AS mean_ms,
  round(p95_duration_ms, 2) AS p95_ms,
  max_duration_ms AS max_ms,
  rows_read,
  max_rows_read,
  rows_returned,
  max_rows_returned,
  formatReadableSize(bytes_read) AS bytes_read,
  formatReadableSize(peak_memory) AS peak_memory,
  substringUTF8(normalized_query, 1, 500) AS normalized_query
FROM aggregated
ORDER BY total_duration_ms DESC
LIMIT $report_limit
"
