#!/usr/bin/env bash

set -euo pipefail

expected_model_id=numind/NuExtract3
worker_url=http://100.113.47.83:8000

systemctl is-enabled --quiet echo-vllm-worker-nuextract.service
systemctl is-active --quiet echo-vllm-worker-nuextract.service
[[ $(/opt/vllm-venv/bin/python -c 'import vllm; print(vllm.__version__)') == 0.26.0 ]]
curl -fsS --max-time 10 "$worker_url/health" >/dev/null
curl -fsS --max-time 10 "$worker_url/v1/models" \
  | python3 -c 'import json,sys; expected=sys.argv[1]; data=json.load(sys.stdin); assert {item["id"] for item in data["data"]} == {expected}' "$expected_model_id"
curl -fsS --max-time 10 "$worker_url/metrics" \
  | python3 -c 'import sys; assert any(line.startswith("vllm:") for line in sys.stdin)'
[[ $(ss -H -ltn 'sport = :8000' | awk '{print $4}') == 100.113.47.83:8000 ]]

printf '[echo-vllm-worker] NuExtract3 production worker verified\n'
