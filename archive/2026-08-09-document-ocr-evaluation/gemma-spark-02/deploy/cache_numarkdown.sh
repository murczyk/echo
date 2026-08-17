#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/host_guard.sh"
VLLM_IMAGE=$(sed -n 's/^VLLM_IMAGE=//p' "$SCRIPT_DIR/runtime.env")

guard_host
sudo docker run --rm \
    --entrypoint /bin/bash \
    -e HF_HOME=/root/.cache/huggingface \
    -v /srv/echo-gemma-ocr/cache/huggingface:/root/.cache/huggingface \
    "$VLLM_IMAGE" \
    -lc 'python3 - <<"PY"
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id="numind/NuMarkdown-8B-Thinking",
    revision="8dfc5236ae68b799d86308aae2f9717fdb50286e",
)
PY'
