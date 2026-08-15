#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TARGET_HOST=${TARGET_HOST:-echo-document-extractor}
CLIENT_HOST=${CLIENT_HOST:-echo-staging}
work=$(mktemp -d /tmp/echo-document-extractor-large.XXXXXX)
tunnel_pid=
cleanup() {
  if [[ -n "$tunnel_pid" ]]; then
    kill "$tunnel_pid" 2>/dev/null || true
    wait "$tunnel_pid" 2>/dev/null || true
  fi
  [[ "$work" == /tmp/echo-document-extractor-large.* ]] && rm -rf -- "$work"
}
trap cleanup EXIT
python3 - "$work/200-pages.pdf" <<'PY'
import sys
from PIL import Image, ImageDraw

pages = []
for index in range(200):
    page = Image.new("RGB", (800, 1100), "white")
    ImageDraw.Draw(page).text((40, 40), f"Synthetic bounded-memory page {index + 1}", fill="black")
    pages.append(page)
pages[0].save(sys.argv[1], save_all=True, append_images=pages[1:])
PY
token=$(ssh -o BatchMode=yes "$TARGET_HOST" \
  "sudo awk -F= '\$1 == \"ECHO_DOCUMENT_EXTRACTOR_TOKEN\" {print substr(\$0, index(\$0, \"=\") + 1)}' /etc/echo-document-extractor/secret.env")
local_port=$(python3 -c 'import socket; value=socket.socket(); value.bind(("127.0.0.1", 0)); print(value.getsockname()[1]); value.close()')
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -N \
  -L "127.0.0.1:$local_port:100.93.77.92:8000" "$CLIENT_HOST" &
tunnel_pid=$!
for _ in {1..50}; do
  if curl -fsS --max-time 1 "http://127.0.0.1:$local_port/health/live" >/dev/null; then
    break
  fi
  kill -0 "$tunnel_pid" 2>/dev/null || { printf 'client tunnel failed\n' >&2; exit 1; }
  sleep 0.2
done
curl -fsS --max-time 1 "http://127.0.0.1:$local_port/health/live" >/dev/null
ECHO_DOCUMENT_EXTRACTOR_TOKEN="$token" OUTPUT_ZIP="$work/result.zip" \
  BASE_URL="http://127.0.0.1:$local_port" \
  "$SCRIPT_DIR/submit-and-wait.sh" "$work/200-pages.pdf" &
client_pid=$!
peak=0
while kill -0 "$client_pid" 2>/dev/null; do
  current=$(ssh -o BatchMode=yes "$TARGET_HOST" \
    "systemctl show -p MemoryCurrent --value echo-document-extractor-worker.service")
  if [[ "$current" =~ ^[0-9]+$ ]] && (( current > peak )); then peak=$current; fi
  sleep 5
done
wait "$client_pid"
unzip -t "$work/result.zip" >/dev/null
(( peak < 13 * 1024 * 1024 * 1024 )) \
  || { printf 'worker peak RSS exceeded 13 GiB: %s bytes\n' "$peak" >&2; exit 1; }
printf 'Synthetic 200-page job passed with peak worker memory %s bytes\n' "$peak"
