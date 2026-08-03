#!/usr/bin/env bash

set -euo pipefail

action=${1:?service action is required}
target_host=${2:-echo-vllm-router}

case "$action" in
  status)
    ssh -o BatchMode=yes "$target_host" \
      systemctl --no-pager --full status echo-vllm-router.service echo-vllm-router-otel.service
    ;;
  logs)
    ssh -o BatchMode=yes "$target_host" \
      sudo journalctl --no-pager -n 100 -u echo-vllm-router.service -u echo-vllm-router-otel.service
    ;;
  start)
    ssh -o BatchMode=yes "$target_host" \
      sudo systemctl start echo-vllm-router.service echo-vllm-router-otel.service
    ;;
  stop)
    ssh -o BatchMode=yes "$target_host" \
      sudo systemctl stop echo-vllm-router-otel.service echo-vllm-router.service
    ;;
  restart)
    ssh -o BatchMode=yes "$target_host" \
      sudo systemctl restart echo-vllm-router.service echo-vllm-router-otel.service
    ;;
  *)
    printf 'unknown service action: %s\n' "$action" >&2
    exit 1
    ;;
esac

