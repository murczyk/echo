#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

client_host=${1:-$DEFAULT_CLIENT_HOST}
payload='{"model":"google/gemma-4-26B-A4B-it","messages":[{"role":"user","content":"Reply with OK."}],"max_tokens":8,"temperature":0}'

validate_bundle
url="http://$ROUTER_HOST:$ROUTER_PORT/v1/chat/completions"
if [[ "$client_host" == local ]]; then
  response=$(printf '%s' "$payload" \
    | curl --fail-with-body -sS --max-time 180 \
      -H 'Content-Type: application/json' \
      --data-binary @- \
      "$url")
else
  response=$(printf '%s' "$payload" \
    | ssh -o BatchMode=yes "$client_host" \
      curl --fail-with-body -sS --max-time 180 \
      -H Content-Type:application/json \
      --data-binary @- \
      "$url")
fi

python3 -c '
import json
import sys

response = json.load(sys.stdin)
assert response.get("object") == "chat.completion", response
assert response.get("choices"), response
choice = response["choices"][0]
assert "message" in choice and "content" in choice["message"], response
response_model = response.get("model")
finish_reason = choice.get("finish_reason")
content = choice["message"]["content"]
print(f"model={response_model}")
print(f"finish_reason={finish_reason}")
print(f"content={content}")
' <<<"$response"
printf '[echo-vllm-router] Inference smoke test passed via %s\n' "$client_host"
