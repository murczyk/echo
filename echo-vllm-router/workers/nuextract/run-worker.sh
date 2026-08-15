#!/usr/bin/env bash

set -euo pipefail

: "${MODEL_SNAPSHOT:?MODEL_SNAPSHOT is required}"
: "${SERVED_MODEL_ID:?SERVED_MODEL_ID is required}"
: "${WORKER_HOST:?WORKER_HOST is required}"
: "${WORKER_PORT:?WORKER_PORT is required}"

[[ "$MODEL_SNAPSHOT" == /var/lib/echo-vllm-worker/huggingface/hub/models--numind--NuExtract3/snapshots/2e9fca82ee641e6bb6e1f5d905241e994be27a07 ]]
[[ "$SERVED_MODEL_ID" == numind/NuExtract3 ]]
[[ "$WORKER_HOST" == 100.113.47.83 ]]
[[ "$WORKER_PORT" == 8000 ]]
[[ -d "$MODEL_SNAPSHOT" ]]
ip -4 -o address show dev tailscale0 | awk '{print $4}' | grep -Fx "$WORKER_HOST/32" >/dev/null

export CUDA_HOME=/opt/vllm-venv/lib/python3.13/site-packages/nvidia/cu13
export HF_HOME=/var/lib/echo-vllm-worker/huggingface
export HF_HUB_OFFLINE=1
export PATH=/opt/vllm-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export TORCH_CUDA_ARCH_LIST=8.9
export TRANSFORMERS_OFFLINE=1
export VLLM_USE_FLASHINFER_SAMPLER=0

exec /opt/vllm-venv/bin/vllm serve "$MODEL_SNAPSHOT" \
  --served-model-name "$SERVED_MODEL_ID" \
  --trust-remote-code \
  --dtype bfloat16 \
  --max-model-len 16384 \
  --gpu-memory-utilization 0.95 \
  --max-num-seqs 1 \
  --limit-mm-per-prompt '{"image":1,"video":0}' \
  --chat-template-content-format openai \
  --generation-config vllm \
  --enforce-eager \
  --host "$WORKER_HOST" \
  --port "$WORKER_PORT"
