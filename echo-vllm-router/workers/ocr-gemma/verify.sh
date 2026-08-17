#!/usr/bin/env bash

set -euo pipefail

expected_hostname=echo-gpu-spark-02
expected_ip=100.95.57.33
expected_gpu_uuid=GPU-a2db5163-9f88-101b-6db3-df4f83412d48
expected_model_id=echo/ocr-gemma-4-26B-A4B-it
worker_url="http://$expected_ip:8000"

[[ $(hostname) == "$expected_hostname" ]]
[[ $(tailscale ip -4) == "$expected_ip" ]]
[[ $(nvidia-smi --query-gpu=uuid --format=csv,noheader,nounits) == "$expected_gpu_uuid" ]]
sudo docker inspect echo-ocr-gemma-vllm --format '{{.State.Health.Status}}' | grep -Fx healthy
curl -fsS --max-time 10 "$worker_url/health" >/dev/null
curl -fsS --max-time 10 "$worker_url/v1/models" \
  | python3 -c 'import json,sys; expected=sys.argv[1]; data=json.load(sys.stdin); assert {item["id"] for item in data["data"]} == {expected}' "$expected_model_id"
curl -fsS --max-time 10 "$worker_url/metrics" \
  | python3 -c 'import sys; assert any(line.startswith("vllm:") for line in sys.stdin)'
[[ $(ss -H -ltn 'sport = :8000' | awk '{print $4}') == "$expected_ip:8000" ]]

printf '[echo-vllm-worker] OCR-Gemma production worker verified\n'
