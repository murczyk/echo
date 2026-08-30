#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
install_root=/opt/echo-vllm-worker/ocr-gemma
docker_dropin_root=/etc/systemd/system/docker.service.d
model_snapshot=/srv/echo-ocr-gemma/cache/huggingface/hub/models--google--gemma-4-26B-A4B-it/snapshots/4d7ae4984b7db7de8f8457170b3f1a419ee76d52

[[ $(hostname) == echo-gpu-spark-02 ]]
tailscale wait --timeout=60s
[[ $(tailscale ip -4) == 100.95.57.33 ]]
[[ $(nvidia-smi --query-gpu=uuid --format=csv,noheader,nounits) == GPU-a2db5163-9f88-101b-6db3-df4f83412d48 ]]
[[ -d "$model_snapshot" ]]

sudo install -d -m 0755 "$install_root"
sudo install -m 0644 "$SCRIPT_DIR/compose.yaml" "$install_root/compose.yaml"
sudo install -m 0644 "$SCRIPT_DIR/runtime.env" "$install_root/runtime.env"
sudo install -m 0755 "$SCRIPT_DIR/verify.sh" "$install_root/verify.sh"
sudo install -d -m 0755 "$docker_dropin_root"
sudo install -m 0644 "$SCRIPT_DIR/docker-tailscale-online.conf" \
  "$docker_dropin_root/echo-ocr-gemma-tailscale-online.conf"
sudo systemctl daemon-reload
sudo docker compose \
  --env-file "$install_root/runtime.env" \
  -f "$install_root/compose.yaml" \
  config --quiet
recreate=()
if sudo docker inspect echo-ocr-gemma-vllm >/dev/null 2>&1 \
  && ! sudo docker port echo-ocr-gemma-vllm 8000/tcp | grep -Fx '100.95.57.33:8000'; then
  recreate=(--force-recreate)
fi
sudo docker compose \
  --env-file "$install_root/runtime.env" \
  -f "$install_root/compose.yaml" \
  up --detach --wait "${recreate[@]}"
"$install_root/verify.sh"
