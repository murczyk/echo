#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/host_guard.sh"

test "$(systemctl get-default)" = multi-user.target
test -z "$(ps -eo comm= | grep -E '^(gdm|gdm3|Xorg|gnome-shell)$' || true)"
test -z "$(nvidia-smi --query-compute-apps=process_name --format=csv,noheader | grep -E '(Xorg|gnome|gdm)' || true)"
sudo docker info --format '{{json .Runtimes}}' | grep -q '"nvidia"'
sudo docker inspect echo-gemma-ocr-vllm --format '{{.State.Health.Status}}' | grep -qx healthy
curl -fsS http://127.0.0.1:8000/health >/dev/null
curl -fsS http://127.0.0.1:8000/v1/models | grep -q 'google/gemma-4-26B-A4B-it'
ss -lntH '( sport = :8000 )' | awk '{print $4}' | grep -qx '127.0.0.1:8000'
test "$(stat -c %a /srv/echo-gemma-ocr/input)" = 700

