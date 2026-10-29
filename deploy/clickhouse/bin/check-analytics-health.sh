#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config
validate_runtime_identifiers
ANALYTICS_RECONCILE_LOCK_WAIT_SECONDS=${ANALYTICS_RECONCILE_LOCK_WAIT_SECONDS:-90}
require_expected_control_release

probe_timeout=${ANALYTICS_HEALTH_PROBE_TIMEOUT_SECONDS:-45}
[[ "$probe_timeout" =~ ^[1-9][0-9]*$ ]] \
  || die "ANALYTICS_HEALTH_PROBE_TIMEOUT_SECONDS must be a positive integer"
if (($# > 0)); then
  [[ $# -eq 2 && $1 == --timeout && $2 =~ ^[1-9][0-9]*$ ]] \
    || die "usage: $0 [--timeout SECONDS]"
  ((probe_timeout <= $2)) || probe_timeout=$2
fi
export PGCONNECT_TIMEOUT=${ANALYTICS_HEALTH_CONNECT_TIMEOUT_SECONDS:-5}
[[ "$PGCONNECT_TIMEOUT" =~ ^[1-9][0-9]*$ ]] \
  || die "ANALYTICS_HEALTH_CONNECT_TIMEOUT_SECONDS must be a positive integer"
slot_name="peerflow_slot_${MIRROR_NAME}"
validate_identifier slot_name "$slot_name"
health_error_file=$(mktemp /tmp/echo-analytics-health.XXXXXX)
trap 'rm -f -- "$health_error_file"' EXIT

report_transient_health_error() {
  local error
  error=$(<"$health_error_file")
  if source_reconciliation_failure_is_transient "$error"; then
    printf '%s\n' "$error" >&2
  fi
}

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

record_probe_delay() {
  local detail=$1
  local source_lsn=${2:-}
  local confirmed_flush_lsn=${3:-}

  postgres_psql \
    --dbname "$GATEWAY_DB" \
    -v ON_ERROR_STOP=1 \
    -v detail="$detail" \
    -v source_lsn="$source_lsn" \
    -v confirmed_flush_lsn="$confirmed_flush_lsn" <<'SQL' >/dev/null
UPDATE public.echo_analytics_health
SET source_lsn = NULLIF(:'source_lsn', '')::pg_lsn,
    confirmed_flush_lsn = NULLIF(:'confirmed_flush_lsn', '')::pg_lsn,
    detail = :'detail'
WHERE singleton;
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
  -v mirror="$MIRROR_NAME" <<'SQL' 2>"$health_error_file"
SELECT status FROM flows WHERE name = :'mirror';
SQL
) || report_transient_health_error
[[ "$flow_status" == 1 ]] \
  || fail_health "mirror is not running (status=${flow_status:-missing})"

nonce=$(< /proc/sys/kernel/random/uuid)
source_updated_at=$(source_psql -Atq -v ON_ERROR_STOP=1 \
  -v nonce="$nonce" <<'SQL' 2>"$health_error_file"
UPDATE echo_analytics.heartbeat
SET nonce = :'nonce'::uuid,
    updated_at = clock_timestamp()
WHERE singleton
RETURNING updated_at;
SQL
) || report_transient_health_error
[[ -n "$source_updated_at" ]] \
  || fail_health "could not update source analytics heartbeat"
source_lsn=$(source_psql -Atq -v ON_ERROR_STOP=1 \
  -c 'SELECT pg_current_wal_lsn()' 2>"$health_error_file") \
  || report_transient_health_error
[[ "$source_lsn" =~ ^[0-9A-F]+/[0-9A-F]+$ ]] \
  || fail_health "could not read source WAL position"

deadline=$((SECONDS + probe_timeout))
confirmed_flush_lsn=
probe_error_detail=
while ((SECONDS < deadline)); do
  slot_state=$(source_psql -Atq -F '|' -v ON_ERROR_STOP=1 \
    -v slot="$slot_name" \
    <<'SQL' 2>"$health_error_file"
SELECT wal_status,
       confirmed_flush_lsn
FROM pg_replication_slots
WHERE slot_name = :'slot';
SQL
  ) || report_transient_health_error
  IFS='|' read -r wal_status confirmed_flush_lsn <<<"$slot_state"
  [[ "$wal_status" != lost && -n "$wal_status" ]] \
    || fail_health "replication slot is missing or lost" \
      "$source_lsn" "$confirmed_flush_lsn"
  probe_error_detail=
  destination_visible=$(gateway_psql -Atq -v ON_ERROR_STOP=1 \
    -v nonce="$nonce" \
    -v source_updated_at="$source_updated_at" <<'SQL' 2>"$health_error_file"
SELECT true
FROM public.echo_analytics__heartbeat
WHERE singleton
  AND (
    nonce::text = :'nonce'
    OR updated_at >= :'source_updated_at'::timestamptz
  );
SQL
  ) || {
    report_transient_health_error
    if grep -Eiq \
      'User memory limit exceeded|Memory limit \(for user\) exceeded|Too many simultaneous queries' \
      "$health_error_file"; then
      probe_error_detail="analytics heartbeat read was rejected by gateway resource limits"
    else
      fail_health "could not read replicated analytics heartbeat" \
        "$source_lsn" "$confirmed_flush_lsn"
    fi
  }
  if [[ "$destination_visible" == t ]]; then
    if ! "$SCRIPT_DIR/reconcile-if-needed.sh" --check; then
      fail_health "analytics desired-state check failed" \
        "$source_lsn" "$confirmed_flush_lsn"
    fi
    record_health true "source heartbeat visible through ClickHouse gateway" \
      "$source_lsn" "$confirmed_flush_lsn"
    log "End-to-end replication probe visible at $confirmed_flush_lsn"
    exit 0
  fi
  sleep 2
done

detail=${probe_error_detail:-"source heartbeat was not visible through ClickHouse within ${probe_timeout}s"}
# Preserve the last successful check time so each consumer's configured
# freshness budget, rather than the shorter probe timeout, decides when to
# reject analytics reads.
record_probe_delay "$detail" "$source_lsn" "$confirmed_flush_lsn" || true
printf '[echo-analytics] ERROR: %s\n' "$detail" >&2
exit 75
