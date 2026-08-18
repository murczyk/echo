#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

action=${1:?service action is required}
target_host=${2:-$DEFAULT_TARGET_HOST}
pool_selector=${POOL:-all}
pool_key=
declare -a units=()

validate_pool_selector "$pool_selector"
while IFS= read -r pool_key; do
  units+=("$(pool_unit "$pool_key")")
done < <(selected_pool_keys "$pool_selector")

case "$action" in
  status)
    ssh -o BatchMode=yes "$target_host" \
      systemctl --no-pager --full status "${units[@]}" echo-vllm-router-otel.service
    ;;
  logs)
    log_args=()
    for unit in "${units[@]}"; do log_args+=(-u "$unit"); done
    ssh -o BatchMode=yes "$target_host" \
      sudo journalctl --no-pager -n 100 "${log_args[@]}" -u echo-vllm-router-otel.service
    ;;
  start)
    ssh -o BatchMode=yes "$target_host" \
      sudo systemctl start "${units[@]}" echo-vllm-router-otel.service
    ;;
  stop)
    if [[ "$pool_selector" == all ]]; then
      ssh -o BatchMode=yes "$target_host" \
        sudo systemctl stop echo-vllm-router-otel.service "${units[@]}"
    else
      ssh -o BatchMode=yes "$target_host" sudo systemctl stop "${units[@]}"
    fi
    ;;
  restart)
    ssh -o BatchMode=yes "$target_host" sudo systemctl restart "${units[@]}"
    if [[ "$pool_selector" == all ]]; then
      ssh -o BatchMode=yes "$target_host" sudo systemctl restart echo-vllm-router-otel.service
    fi
    ;;
  *)
    printf 'unknown service action: %s\n' "$action" >&2
    exit 1
    ;;
esac
