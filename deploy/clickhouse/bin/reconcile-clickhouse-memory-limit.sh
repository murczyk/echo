#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config

check_only=false
case ${1:-} in
  '')
    ;;
  --check)
    check_only=true
    ;;
  *)
    die "usage: $0 [--check]"
    ;;
esac

config_file=${ANALYTICS_CLICKHOUSE_MEMORY_CONFIG_FILE:-/etc/clickhouse-server/config.d/echo-memory-limit.xml}
limit_bytes=$(clickhouse_memory_limit_bytes)
temporary_file=$(mktemp)
trap 'rm -f -- "$temporary_file"' EXIT
cat >"$temporary_file" <<EOF
<clickhouse>
  <max_server_memory_usage>$limit_bytes</max_server_memory_usage>
</clickhouse>
EOF

configured_limit=$(clickhouse_admin --query "
SELECT value
FROM system.server_settings
WHERE name = 'max_server_memory_usage'
FORMAT TSVRaw
")

if $check_only; then
  cmp -s "$temporary_file" "$config_file" \
    || die "ClickHouse memory-limit configuration is stale"
  [[ "$configured_limit" == "$limit_bytes" ]] \
    || die "ClickHouse memory limit is $configured_limit, expected $limit_bytes"
  exit 0
fi

if ! cmp -s "$temporary_file" "$config_file" \
  || [[ "$configured_limit" != "$limit_bytes" ]]; then
  if [[ $(id -u) -eq 0 ]]; then
    install -o root -g clickhouse -m 0644 "$temporary_file" "$config_file"
  else
    install -m 0644 "$temporary_file" "$config_file"
  fi
  clickhouse_admin --query 'SYSTEM RELOAD CONFIG'
fi

configured_limit=$(clickhouse_admin --query "
SELECT value
FROM system.server_settings
WHERE name = 'max_server_memory_usage'
FORMAT TSVRaw
")
[[ "$configured_limit" == "$limit_bytes" ]] \
  || die "failed to apply ClickHouse memory limit $limit_bytes (found $configured_limit)"
log "ClickHouse memory limit is reconciled at $limit_bytes bytes"
