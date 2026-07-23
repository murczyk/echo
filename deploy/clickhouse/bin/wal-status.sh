#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_source_config

require_cmd psql
require_cmd sudo

source_local_psql -P pager=off <<'SQL'
WITH settings AS (
  SELECT CASE
    WHEN current_setting('max_slot_wal_keep_size') = '-1' THEN NULL
    ELSE pg_size_bytes(current_setting('max_slot_wal_keep_size'))
  END AS cap
)
SELECT slot_name,
       active,
       active_pid,
       wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained,
       CASE WHEN settings.cap IS NULL THEN NULL
            ELSE round(
              100 * pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) / settings.cap,
              1
            )
       END AS cap_percent,
       pg_size_pretty(safe_wal_size) AS safe_wal_remaining,
       confirmed_flush_lsn,
       inactive_since,
       invalidation_reason
FROM pg_replication_slots, settings
WHERE slot_type = 'logical'
  AND database = current_database()
ORDER BY slot_name;
SQL

data_dir=$(source_local_psql -Atqc "SHOW data_directory")
printf '\nSource data filesystem\n'
df -h "$data_dir"

read -r worst_percent lost_count < <(
  source_local_psql -Atq -F ' ' <<'SQL'
WITH settings AS (
  SELECT CASE
    WHEN current_setting('max_slot_wal_keep_size') = '-1' THEN NULL
    ELSE pg_size_bytes(current_setting('max_slot_wal_keep_size'))
  END AS cap
), slots AS (
  SELECT wal_status,
         CASE WHEN settings.cap IS NULL THEN 0
              ELSE 100 * pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) / settings.cap
         END AS cap_percent
  FROM pg_replication_slots, settings
  WHERE slot_type = 'logical' AND database = current_database()
)
SELECT COALESCE(max(cap_percent), 0)::integer,
       count(*) FILTER (WHERE wal_status = 'lost')
FROM slots;
SQL
)

if ((lost_count > 0)); then
  die "a logical slot is lost; repair the analytics stack and run an explicit mirror resync"
fi
if ((worst_percent >= WAL_CRITICAL_PERCENT)); then
  die "retained WAL is at ${worst_percent}% of the configured cap"
fi
if ((worst_percent >= WAL_WARN_PERCENT)); then
  printf '[echo-analytics] WARNING: retained WAL is at %s%% of the configured cap\n' "$worst_percent" >&2
fi
