#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config
validate_runtime_identifiers

for command in jq mc psql temporal; do
  require_cmd "$command"
done

source_psql -v ON_ERROR_STOP=1 -Atqc 'SELECT 1' >/dev/null \
  || die "the source PostgreSQL is not reachable with the PeerDB role"
wait_for_command PeerDB peerdb_psql -Atqc 'SELECT 1'
wait_for_command "PeerDB Flow API" timeout 2 bash -c \
  "</dev/tcp/127.0.0.1/${PEERDB_FLOW_GRPC_PORT:-8112}"

log "Ensuring the private MinIO staging bucket and lifecycle"
mc_dir=$(mktemp -d /tmp/echo-analytics-mc.XXXXXX)
sql_file=$(mktemp /tmp/echo-peerdb-mirror.XXXXXX.sql)
trap 'rm -rf -- "$mc_dir"; rm -f -- "$sql_file"' EXIT
export MC_HOST_echo_minio
MC_HOST_echo_minio=$(minio_mc_host)
MC_CONFIG_DIR=$mc_dir mc mb --ignore-existing "echo_minio/$MINIO_BUCKET" >/dev/null
MC_CONFIG_DIR=$mc_dir mc ilm rule remove --all --force "echo_minio/$MINIO_BUCKET" >/dev/null 2>&1 || true
MC_CONFIG_DIR=$mc_dir mc ilm rule add \
  --expire-days "${MINIO_EXPIRE_DAYS:-14}" \
  "echo_minio/$MINIO_BUCKET" >/dev/null

log "Enabling PeerDB WAL heartbeats, nullable columns, and string-backed JSON compatibility"
catalog_psql -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO dynamic_settings (config_name, config_value)
VALUES
  ('PEERDB_ENABLE_WAL_HEARTBEAT', 'true'),
  ('PEERDB_CLICKHOUSE_ENABLE_JSON', 'false'),
  ('PEERDB_CLICKHOUSE_ENABLE_PRIMARY_UPDATE', 'true'),
  ('PEERDB_NULLABLE', 'true')
ON CONFLICT (config_name) DO UPDATE
SET config_value = EXCLUDED.config_value;
SQL

"$SCRIPT_DIR/render-mirror-sql.sh" "$sql_file"
log "Creating idempotent PeerDB peers and mirror"
peerdb_psql -v ON_ERROR_STOP=1 -f "$sql_file"
rm -f -- "$sql_file"

log "Mirror submitted; use status.sh and refresh-current-views.sh as snapshot tables appear"
