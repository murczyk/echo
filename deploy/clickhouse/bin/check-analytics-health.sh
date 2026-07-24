#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config
validate_runtime_identifiers

probe_timeout=${ANALYTICS_HEALTH_PROBE_TIMEOUT_SECONDS:-45}
[[ "$probe_timeout" =~ ^[1-9][0-9]*$ ]] \
  || die "ANALYTICS_HEALTH_PROBE_TIMEOUT_SECONDS must be a positive integer"
export PGCONNECT_TIMEOUT=${ANALYTICS_HEALTH_CONNECT_TIMEOUT_SECONDS:-5}
[[ "$PGCONNECT_TIMEOUT" =~ ^[1-9][0-9]*$ ]] \
  || die "ANALYTICS_HEALTH_CONNECT_TIMEOUT_SECONDS must be a positive integer"
slot_name="peerflow_slot_${MIRROR_NAME}"
validate_identifier slot_name "$slot_name"

record_health() {
  local healthy=$1
  local detail=$2
  local source_lsn=${3:-}
  local confirmed_flush_lsn=${4:-}

  postgres_psql \
    --dbname "$GATEWAY_DB" \
    -v ON_ERROR_STOP=1 \
    -v healthy="$healthy" \
    -v detail="$detail" \
    -v source_lsn="$source_lsn" \
    -v confirmed_flush_lsn="$confirmed_flush_lsn" <<'SQL' >/dev/null
INSERT INTO public.echo_analytics_health (
  singleton,
  checked_at,
  healthy,
  source_lsn,
  confirmed_flush_lsn,
  detail
)
VALUES (
  true,
  clock_timestamp(),
  :'healthy'::boolean,
  NULLIF(:'source_lsn', '')::pg_lsn,
  NULLIF(:'confirmed_flush_lsn', '')::pg_lsn,
  :'detail'
)
ON CONFLICT (singleton) DO UPDATE
SET checked_at = EXCLUDED.checked_at,
    healthy = EXCLUDED.healthy,
    source_lsn = EXCLUDED.source_lsn,
    confirmed_flush_lsn = EXCLUDED.confirmed_flush_lsn,
    detail = EXCLUDED.detail;
SQL
}

fail_health() {
  local detail=$1
  local source_lsn=${2:-}
  local confirmed_flush_lsn=${3:-}
  record_health false "$detail" "$source_lsn" "$confirmed_flush_lsn" || true
  die "$detail"
}

for unit in \
  clickhouse-server.service \
  postgresql@18-main.service \
  echo-temporal.service \
  echo-minio.service \
  echo-peer-flow-api.service \
  echo-peer-flow-worker.service \
  echo-peer-flow-snapshot-worker.service \
  echo-peerdb-server.service
do
  systemctl is-active --quiet "$unit" \
    || fail_health "required service is not active: $unit"
done

flow_status=$(catalog_psql -Atq \
  -v ON_ERROR_STOP=1 \
  -v mirror="$MIRROR_NAME" <<'SQL' 2>/dev/null || true
SELECT status FROM flows WHERE name = :'mirror';
SQL
)
[[ "$flow_status" == 1 ]] \
  || fail_health "mirror is not running (status=${flow_status:-missing})"

nonce=$(< /proc/sys/kernel/random/uuid)
source_updated_at=$(source_psql -Atq -v ON_ERROR_STOP=1 \
  -v nonce="$nonce" <<'SQL' 2>/dev/null || true
UPDATE echo_analytics.heartbeat
SET nonce = :'nonce'::uuid,
    updated_at = clock_timestamp()
WHERE singleton
RETURNING updated_at;
SQL
)
[[ -n "$source_updated_at" ]] \
  || fail_health "could not update source analytics heartbeat"
source_lsn=$(source_psql -Atq -v ON_ERROR_STOP=1 \
  -c 'SELECT pg_current_wal_lsn()' 2>/dev/null || true)
[[ "$source_lsn" =~ ^[0-9A-F]+/[0-9A-F]+$ ]] \
  || fail_health "could not read source WAL position"

deadline=$((SECONDS + probe_timeout))
confirmed_flush_lsn=
while ((SECONDS < deadline)); do
  slot_state=$(source_psql -Atq -F '|' -v ON_ERROR_STOP=1 \
    -v slot="$slot_name" \
    <<'SQL' 2>/dev/null || true
SELECT wal_status,
       confirmed_flush_lsn
FROM pg_replication_slots
WHERE slot_name = :'slot';
SQL
  )
  IFS='|' read -r wal_status confirmed_flush_lsn <<<"$slot_state"
  [[ "$wal_status" != lost && -n "$wal_status" ]] \
    || fail_health "replication slot is missing or lost" \
      "$source_lsn" "$confirmed_flush_lsn"
  destination_visible=$(gateway_psql -Atq -v ON_ERROR_STOP=1 \
    -v nonce="$nonce" \
    -v source_updated_at="$source_updated_at" <<'SQL' 2>/dev/null || true
SELECT true
FROM public.echo_analytics__heartbeat
WHERE singleton
  AND (
    nonce::text = :'nonce'
    OR updated_at >= :'source_updated_at'::timestamptz
  );
SQL
  )
  if [[ "$destination_visible" == t ]]; then
    if ! "$SCRIPT_DIR/reconcile-schema.sh"; then
      fail_health "analytics schema reconciliation failed" \
        "$source_lsn" "$confirmed_flush_lsn"
    fi
    if ! "$SCRIPT_DIR/reconcile-derived-schema.sh"; then
      fail_health "derived analytics schema reconciliation failed" \
        "$source_lsn" "$confirmed_flush_lsn"
    fi
    record_health true "source heartbeat visible through ClickHouse gateway" \
      "$source_lsn" "$confirmed_flush_lsn"
    log "End-to-end replication probe visible at $confirmed_flush_lsn"
    exit 0
  fi
  sleep 2
done

fail_health "source heartbeat was not visible through ClickHouse within ${probe_timeout}s" \
  "$source_lsn" "$confirmed_flush_lsn"
