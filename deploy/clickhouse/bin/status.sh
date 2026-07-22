#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config
require_cmd jq

failures=0

printf 'Systemd units\n'
for unit in \
  echo-analytics.target \
  echo-analytics-firewall.service \
  postgresql@18-main.service \
  clickhouse-server.service \
  echo-temporal.service \
  echo-minio.service \
  echo-peerdb-migrate.service \
  echo-peer-flow-api.service \
  echo-peer-flow-worker.service \
  echo-peer-flow-snapshot-worker.service \
  echo-peerdb-server.service \
  echo-analytics-health.timer
do
  state=$(systemctl is-active "$unit" 2>/dev/null || true)
  printf '  %-42s %s\n' "$unit" "$state"
  [[ "$state" == active ]] || failures=$((failures + 1))
done

printf '\nEndpoints\n'
printf '  %-42s ' 'source PostgreSQL'
if source_psql -Atqc 'SELECT 1' >/dev/null 2>&1; then
  printf 'ok\n'
else
  printf 'unavailable\n'
  failures=$((failures + 1))
fi
printf '  %-42s ' 'application PostgreSQL gateway'
if gateway_psql -Atqc 'SELECT 1' >/dev/null 2>&1; then
  printf 'ok\n'
else
  printf 'unavailable\n'
  failures=$((failures + 1))
fi
printf '  %-42s ' 'ClickHouse'
if clickhouse_admin --query 'SELECT 1' >/dev/null 2>&1; then
  printf 'ok\n'
else
  printf 'unavailable\n'
  failures=$((failures + 1))
fi
printf '  %-42s ' 'PeerDB PostgreSQL wire'
if peerdb_psql -Atqc 'SELECT 1' >/dev/null 2>&1; then
  printf 'ok\n'
else
  printf 'unavailable\n'
  failures=$((failures + 1))
fi
printf '  %-42s ' 'Temporal'
if temporal --address "127.0.0.1:${TEMPORAL_PORT:-7233}" \
  operator namespace list >/dev/null 2>&1
then
  printf 'ok\n'
else
  printf 'unavailable\n'
  failures=$((failures + 1))
fi

printf '\nReplication freshness\n'
health_state=$(gateway_psql -Atq \
  -v stale_after_seconds="${ANALYTICS_HEALTH_STALE_AFTER_SECONDS:-90}" <<'SQL' 2>/dev/null || true
SELECT (healthy AND checked_at >= CURRENT_TIMESTAMP
        - (:'stale_after_seconds'::bigint * INTERVAL '1 second'))::text
       || '|' || checked_at::text || '|' || detail
FROM public.echo_analytics_health
WHERE singleton;
SQL
)
if [[ "$health_state" == true\|* ]]; then
  printf '  %s\n' "$health_state"
else
  printf '  unhealthy or unavailable: %s\n' "${health_state:-no row}"
  failures=$((failures + 1))
fi

printf '\nMirror catalog\n'
if ! catalog_psql -P pager=off -c "
  SELECT name,
         CASE status
           WHEN 0 THEN 'UNKNOWN'
           WHEN 1 THEN 'RUNNING'
           WHEN 2 THEN 'PAUSED'
           WHEN 3 THEN 'PAUSING'
           WHEN 4 THEN 'SETUP'
           WHEN 5 THEN 'SNAPSHOT'
           WHEN 6 THEN 'TERMINATING'
           WHEN 7 THEN 'TERMINATED'
           WHEN 8 THEN 'COMPLETED'
           WHEN 9 THEN 'RESYNC'
           WHEN 10 THEN 'FAILED'
           WHEN 11 THEN 'MODIFYING'
           ELSE 'INVALID:' || status::text
         END AS status,
         updated_at
  FROM flows
  ORDER BY updated_at DESC
" 2>/dev/null; then
  printf '  flow catalog unavailable\n'
  failures=$((failures + 1))
elif [[ $(catalog_psql -Atqc \
  "SELECT count(*) FROM flows WHERE name = '$(sql_literal "$MIRROR_NAME")' AND status = 1") != 1 ]]; then
  printf '  expected mirror is not running: %s\n' "$MIRROR_NAME"
  failures=$((failures + 1))
fi

printf '\nClickHouse objects\n'
if ! clickhouse_admin --query "
  SELECT database, name, engine, total_rows
  FROM system.tables
  WHERE database IN ('$CLICKHOUSE_RAW_DB', '$CLICKHOUSE_CURRENT_DB')
  ORDER BY database, name
" 2>/dev/null; then
  printf '  ClickHouse catalog unavailable\n'
  failures=$((failures + 1))
fi

printf '\nMinIO stage usage\n'
mc_dir=$(mktemp -d /tmp/echo-analytics-status-mc.XXXXXX)
trap 'rm -rf -- "$mc_dir"' EXIT
export MC_HOST_echo_minio
MC_HOST_echo_minio=$(minio_mc_host)
if ! MC_CONFIG_DIR=$mc_dir mc du "echo_minio/$MINIO_BUCKET"; then
  printf '  MinIO unavailable\n'
  failures=$((failures + 1))
fi

if ((failures > 0)); then
  printf '\nHealth check failures: %s\n' "$failures" >&2
  exit 1
fi
