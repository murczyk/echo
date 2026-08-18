#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
LAYOUT_MANIFEST=${LAYOUT_MANIFEST:-$PROJECT_DIR/layout-suite-manifest.json}
LAYOUT_OUTPUT_DIR=${LAYOUT_OUTPUT_DIR:-$PROJECT_DIR/raw/layout-suite-numarkdown-bf16}
source "$SCRIPT_DIR/host_guard.sh"

restore_gemma() {
    trap - EXIT HUP INT TERM
    set +e
    guard_host
    sudo docker compose -p echo-numarkdown-ocr --env-file "$SCRIPT_DIR/runtime.env" -f "$SCRIPT_DIR/compose_numarkdown.yaml" stop
    guard_host
    sudo docker compose --env-file "$SCRIPT_DIR/runtime.env" -f "$SCRIPT_DIR/compose.yaml" up -d
}

trap restore_gemma EXIT HUP INT TERM
guard_host
sudo docker compose --env-file "$SCRIPT_DIR/runtime.env" -f "$SCRIPT_DIR/compose.yaml" stop
guard_host
sudo docker compose -p echo-numarkdown-ocr --env-file "$SCRIPT_DIR/runtime.env" -f "$SCRIPT_DIR/compose_numarkdown.yaml" up -d

for _ in $(seq 1 300); do
    if curl --silent --fail http://127.0.0.1:8000/health >/dev/null; then
        break
    fi
    if [[ $(sudo docker inspect -f '{{.State.Status}}' echo-numarkdown-ocr-vllm) == exited ]]; then
        sudo docker logs --tail 240 echo-numarkdown-ocr-vllm
        exit 1
    fi
    sleep 2
done

curl --silent --fail http://127.0.0.1:8000/health >/dev/null
python3 "$PROJECT_DIR/harness/run_numarkdown_layout.py" \
    --manifest "$LAYOUT_MANIFEST" \
    --input-dir "$PROJECT_DIR/input" \
    --output-dir "$LAYOUT_OUTPUT_DIR" \
    --resume
