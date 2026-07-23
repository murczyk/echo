#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PEERDB_VERSION_FILE=${ECHO_ANALYTICS_VERSIONS_FILE:-$SCRIPT_DIR/../versions.env}
# shellcheck source=../versions.env
source "$PEERDB_VERSION_FILE"

export PATH="/usr/lib/postgresql/$POSTGRESQL_MAJOR/bin:/usr/local/bin:/usr/bin:/bin"
export PEERDB_CATALOG_HOST=127.0.0.1
export PEERDB_CATALOG_PORT="${ANALYTICS_GATEWAY_PORT:-5432}"
export PEERDB_CATALOG_USER="$CATALOG_USER"
export PEERDB_CATALOG_PASSWORD="$CATALOG_PASSWORD"
export PEERDB_CATALOG_DATABASE="$CATALOG_DB"
export TEMPORAL_HOST_PORT="127.0.0.1:${TEMPORAL_PORT:-7233}"
export PEERDB_TEMPORAL_NAMESPACE=default
export PEERDB_CLICKHOUSE_AWS_CREDENTIALS_AWS_ACCESS_KEY_ID="$MINIO_ROOT_USER"
export PEERDB_CLICKHOUSE_AWS_CREDENTIALS_AWS_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD"
export PEERDB_CLICKHOUSE_AWS_CREDENTIALS_AWS_REGION=us-east-1
export PEERDB_CLICKHOUSE_AWS_CREDENTIALS_AWS_ENDPOINT_URL_S3="http://127.0.0.1:${MINIO_API_PORT:-9002}"
export PEERDB_CLICKHOUSE_AWS_S3_BUCKET_NAME="$MINIO_BUCKET"
export AWS_EC2_METADATA_DISABLED=true
export PEERDB_VERSION_SHA_SHORT="echo-$PEERDB_VERSION"
export PEERDB_ENABLE_WAL_HEARTBEAT=true
export PEERDB_CLICKHOUSE_ENABLE_JSON=false
export PEERDB_CLICKHOUSE_ENABLE_PRIMARY_UPDATE=true
export PEERDB_NULLABLE=true

mode=${1:-}
if (($# > 0)); then
  shift
fi

case "$mode" in
  api)
    peer_flow_command=(/opt/peerdb/bin/peer-flow api \
      --port "${PEERDB_FLOW_GRPC_PORT:-8112}" \
      --gateway-port "${PEERDB_FLOW_HTTP_PORT:-8113}")
    ;;
  worker|snapshot-worker|maintenance)
    peer_flow_command=(/opt/peerdb/bin/peer-flow "$mode")
    ;;
  *)
    printf 'unknown peer-flow mode: %s\n' "$mode" >&2
    exit 2
    ;;
esac

for attempt in $(seq 1 60); do
  if timeout 2 temporal --address "$TEMPORAL_HOST_PORT" \
    operator namespace describe \
    --namespace "$PEERDB_TEMPORAL_NAMESPACE" >/dev/null 2>&1
  then
    exec "${peer_flow_command[@]}" "$@"
  fi
  sleep 2
done

printf 'Temporal namespace %s did not become ready at %s\n' \
  "$PEERDB_TEMPORAL_NAMESPACE" "$TEMPORAL_HOST_PORT" >&2
exit 1
