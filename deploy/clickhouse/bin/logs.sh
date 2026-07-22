#!/usr/bin/env bash

set -euo pipefail

unit=${1:-echo-peer-flow-worker.service}
lines=${LINES:-100}

case "$unit" in
  clickhouse-server.service|postgresql@18-main.service|echo-temporal.service|echo-minio.service|echo-peerdb-migrate.service|echo-peer-flow-api.service|echo-peer-flow-worker.service|echo-peer-flow-snapshot-worker.service|echo-peerdb-server.service|echo-analytics-health.service)
    ;;
  *)
    printf 'unsupported analytics unit: %s\n' "$unit" >&2
    exit 2
    ;;
esac

exec sudo journalctl -u "$unit" -n "$lines" -f
