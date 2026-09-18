#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=./clickhouse-system-log-policy.sh
source "$SCRIPT_DIR/clickhouse-system-log-policy.sh"
# shellcheck source=./clickhouse-system-log-cleanup.sh
source "$SCRIPT_DIR/clickhouse-system-log-cleanup.sh"

usage() {
  printf 'usage: %s [--profile=analytics|signoz] --check | --apply (--expire|--truncate) --yes\n' "$0" >&2
}

mode='' profile=analytics check=false apply=false truncate=false expire=false confirmed=false
for argument in "$@"; do
  case $argument in
    --check)
      $check && die "--check was specified more than once"
      check=true
      ;;
    --apply)
      $apply && die "--apply was specified more than once"
      apply=true
      ;;
    --truncate)
      $truncate && die "--truncate was specified more than once"
      truncate=true
      ;;
    --expire)
      $expire && die "--expire was specified more than once"
      expire=true
      ;;
    --profile=analytics|--profile=signoz)
      profile=${argument#*=}
      ;;
    --yes)
      $confirmed && die "--yes was specified more than once"
      confirmed=true
      ;;
    *)
      usage
      die "unknown argument: $argument"
      ;;
  esac
done

if $check && ! $apply && ! $truncate && ! $expire && ! $confirmed; then
  mode=check
elif ! $check && $apply && $confirmed && { { $truncate && ! $expire; } || { $expire && ! $truncate; }; }; then
  mode=apply
else
  usage
  die "mutating mode requires --apply, exactly one of --expire/--truncate, and --yes"
fi

if [[ "$profile" == signoz ]]; then
  require_cmd python3
  clickhouse_admin() {
    python3 "$SCRIPT_DIR/signoz-clickhouse-client.py" "$@"
  }
else
  source_env_file "$INSTANCE_FILE"
  source_env_file "$CLICKHOUSE_SECRETS_FILE"
  require_secret CLICKHOUSE_ADMIN_PASSWORD
fi
require_cmd clickhouse-client
require_cmd clickhouse

clickhouse_admin --query 'SELECT 1' >/dev/null \
  || die "authenticated ClickHouse health check failed"
discover_clickhouse_system_logs
if [[ "$mode" == check ]]; then
  report_clickhouse_system_log_policy
  verify_clickhouse_system_log_policy
  log "ClickHouse system-log policy is healthy"
  exit 0
fi

for command in cmp install mktemp sudo systemctl; do
  require_cmd "$command"
done

validate_rendered_clickhouse_system_log_config
# A prepared system-log table is renamed on restart when its CREATE definition
# differs from the configured one. Flush first, then align the live TTLs so the
# restart keeps the existing table identities.
prepare_clickhouse_system_logs
discover_clickhouse_system_logs
validate_clickhouse_system_log_inventory
validate_rendered_clickhouse_system_log_config
validate_merged_clickhouse_system_log_config
backup_clickhouse_system_log_policy
log "Aligning existing ClickHouse diagnostic-table TTLs"
apply_clickhouse_system_log_ttls
log "Installing the bounded ClickHouse system-log policy"
install_clickhouse_system_log_config
sudo systemctl restart clickhouse-server
wait_for_authenticated_clickhouse
flush_clickhouse_system_logs
verify_clickhouse_system_log_identities
verify_clickhouse_system_log_policy

if $expire; then
  expire_clickhouse_system_logs
else
  log "Synchronously truncating the four legacy managed ClickHouse diagnostic tables"
  truncate_clickhouse_system_logs
fi
discover_clickhouse_system_logs
report_clickhouse_system_log_policy
verify_clickhouse_system_log_policy
log "ClickHouse system-log maintenance completed"
