#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/host_guard.sh"

test "$(systemctl get-default)" = multi-user.target

guard_host
sudo nvidia-ctk runtime configure --runtime=docker
guard_host
sudo systemctl enable --now docker
guard_host
sudo systemctl restart docker
sudo docker info --format '{{json .Runtimes}}' | grep -q '"nvidia"'

guard_host
sudo install -d -m 0755 -o echo -g echo /srv/echo-gemma-ocr
guard_host
sudo install -d -m 0755 -o echo -g echo \
    /srv/echo-gemma-ocr/cache/huggingface \
    /srv/echo-gemma-ocr/cache/vllm \
    /srv/echo-gemma-ocr/cache/flashinfer \
    /srv/echo-gemma-ocr/cache/triton \
    /srv/echo-gemma-ocr/raw \
    /srv/echo-gemma-ocr/metrics
guard_host
sudo install -d -m 0700 -o echo -g echo /srv/echo-gemma-ocr/input

