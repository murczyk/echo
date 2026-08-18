#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

client_host=${1:-$DEFAULT_CLIENT_HOST}
pool_selector=${POOL:-all}

build_payload() {
  local pool=$1
  local expected_model_id=$2

  python3 - "$pool" "$expected_model_id" <<'PY'
import base64
import binascii
import json
import struct
import sys
import zlib

pool, model_id = sys.argv[1:]
if pool == "general-gemma":
    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": "Reply with OK."}],
        "max_tokens": 8,
        "temperature": 0,
    }
else:
    width = height = 64
    rows = []
    for y in range(height):
        row = bytearray()
        for x in range(width):
            dark = (10 <= x <= 15 and 10 <= y <= 53) or (
                10 <= x <= 48 and y in range(10, 16)
            ) or (10 <= x <= 42 and y in range(29, 35)) or (
                10 <= x <= 48 and y in range(48, 54)
            )
            row.extend((0, 0, 0) if dark else (255, 255, 255))
        rows.append(b"\x00" + bytes(row))

    def chunk(kind, data):
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", binascii.crc32(kind + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(b"".join(rows)))
    png += chunk(b"IEND", b"")
    payload = {
        "model": model_id,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Transcribe this image. Return only the visible text."},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "data:image/png;base64," + base64.b64encode(png).decode()
                        },
                    },
                ],
            }
        ],
        "max_tokens": 32,
        "temperature": 0,
    }
    if pool == "nuextract":
        payload["chat_template_kwargs"] = {"mode": "markdown", "enable_thinking": False}

print(json.dumps(payload, separators=(",", ":")))
PY
}

send_request() {
  local payload=$1
  local url=$2

  if [[ "$client_host" == local ]]; then
    printf '%s' "$payload" \
      | curl --fail-with-body -sS --max-time 180 \
        -H 'Content-Type: application/json' \
        --data-binary @- \
        "$url"
  else
    printf '%s' "$payload" \
      | ssh -o BatchMode=yes "$client_host" \
        curl --fail-with-body -sS --max-time 180 \
        -H Content-Type:application/json \
        --data-binary @- \
        "$url"
  fi
}

validate_response() {
  local pool=$1
  local expected_model_id=$2

  python3 -c '
import json
import sys

pool, expected_model = sys.argv[1:]
response = json.load(sys.stdin)
assert response.get("object") == "chat.completion", response
assert response.get("model") == expected_model, response
assert response.get("choices"), response
choice = response["choices"][0]
assert "message" in choice and isinstance(choice["message"].get("content"), str), response
print(f"pool={pool}")
print("model={}".format(response.get("model")))
print("finish_reason={}".format(choice.get("finish_reason")))
' "$pool" "$expected_model_id"
}

validate_bundle
validate_pool_selector "$pool_selector"
while IFS= read -r pool_key; do
  load_pool "$pool_key"
  payload=$(build_payload "$ROUTER_POOL" "$ROUTER_EXPECTED_MODEL_ID")
  url="http://$ROUTER_HOST:$ROUTER_PORT/v1/chat/completions"
  response=$(send_request "$payload" "$url")
  validate_response "$ROUTER_POOL" "$ROUTER_EXPECTED_MODEL_ID" <<<"$response"
done < <(selected_pool_keys "$pool_selector")

printf '[echo-vllm-router] Inference smoke tests passed via %s\n' "$client_host"
