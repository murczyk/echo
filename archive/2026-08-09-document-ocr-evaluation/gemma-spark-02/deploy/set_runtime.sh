#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/host_guard.sh"

VISION_BUDGET=${1:?usage: set_runtime.sh 280|1120 fp8|bf16}
PRECISION=${2:?usage: set_runtime.sh 280|1120 fp8|bf16}

case "$VISION_BUDGET" in
    280 | 1120) ;;
    *) exit 2 ;;
esac

case "$PRECISION" in
    fp8) PRECISION_ARGS='--quantization fp8 --kv-cache-dtype fp8' ;;
    bf16) PRECISION_ARGS='' ;;
    *) exit 2 ;;
esac

guard_host
sed -i "s/^VISION_BUDGET=.*/VISION_BUDGET=$VISION_BUDGET/" "$SCRIPT_DIR/runtime.env"
guard_host
sed -i "s|^PRECISION_ARGS=.*|PRECISION_ARGS=$PRECISION_ARGS|" "$SCRIPT_DIR/runtime.env"
guard_host
sudo docker compose --env-file "$SCRIPT_DIR/runtime.env" -f "$SCRIPT_DIR/compose.yaml" up -d --force-recreate

