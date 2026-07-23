#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PEERDB_VERSION_FILE=${ECHO_ANALYTICS_VERSIONS_FILE:-$SCRIPT_DIR/../versions.env}
# shellcheck source=../versions.env
source "$PEERDB_VERSION_FILE"

mode=${1:-serve}
if (($# > 0)); then
  shift
fi

export PATH="/usr/lib/postgresql/$POSTGRESQL_MAJOR/bin:/usr/local/bin:/usr/bin:/bin"
export PEERDB_HOST=127.0.0.1
export PEERDB_PORT="${PEERDB_PORT:-9900}"
export PEERDB_PASSWORD
export PEERDB_CATALOG_HOST=127.0.0.1
export PEERDB_CATALOG_PORT="${ANALYTICS_GATEWAY_PORT:-5432}"
export PEERDB_CATALOG_USER="$CATALOG_USER"
export PEERDB_CATALOG_PASSWORD="$CATALOG_PASSWORD"
export PEERDB_CATALOG_DATABASE="$CATALOG_DB"
export PEERDB_FLOW_SERVER_ADDRESS="grpc://127.0.0.1:${PEERDB_FLOW_GRPC_PORT:-8112}"
export PEERDB_LOG_DIR=/var/log/echo-analytics
export RUST_LOG=${RUST_LOG:-info}
export RUST_BACKTRACE=1

case "$mode" in
  migrate)
    export PEERDB_MIGRATIONS_ONLY=true
    ;;
  serve-no-migrate)
    export PEERDB_MIGRATIONS_DISABLED=true
    ;;
  serve)
    ;;
  *)
    printf 'unknown peerdb-server mode: %s\n' "$mode" >&2
    exit 2
    ;;
esac

exec /opt/peerdb/bin/peerdb-server "$@"
