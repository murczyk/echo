#!/usr/bin/env bash
set -euo pipefail

readonly DEPLOYMENT_MAINTENANCE_REDIS_KEY="echo:deployment:maintenance"
readonly DEPLOYMENT_MAINTENANCE_TTL_SECONDS=120

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <start|renew|keepalive|clear> <server>" >&2
  exit 1
fi

action="$1"
server="$2"

if [[ "$action" == keepalive ]]; then
  exec python3 - "$server" "${BASH_SOURCE[0]}" "$PPID" <<'PY'
import os
import signal
import subprocess
import sys
import time

server, script, deploy_parent = sys.argv[1:]
deploy_parent = int(deploy_parent)
if deploy_parent <= 1:
    sys.exit(0)

def stop(signum, frame):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)

def renew():
    process = subprocess.Popen(["bash", script, "renew", server], start_new_session=True)
    try:
        return process.wait(timeout=20)
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()

while os.getppid() == deploy_parent:
    try:
        if renew():
            print("WARNING: deployment maintenance renewal failed", file=sys.stderr, flush=True)
    except subprocess.TimeoutExpired:
        print("WARNING: deployment maintenance renewal timed out", file=sys.stderr, flush=True)
    for _ in range(30):
        if os.getppid() != deploy_parent:
            sys.exit(0)
        time.sleep(1)
PY
fi

ssh -o BatchMode=yes -o ConnectTimeout=10 \
  -o ServerAliveInterval=5 -o ServerAliveCountMax=2 "$server" bash -s -- \
  "$action" \
  "$DEPLOYMENT_MAINTENANCE_REDIS_KEY" \
  "$DEPLOYMENT_MAINTENANCE_TTL_SECONDS" <<'REMOTE'
set -euo pipefail

action="$1"
maintenance_key="$2"
maintenance_ttl_seconds="$3"
redis=(redis-cli --raw)

wake_event_streams() {
  local created_at_ms event_json session_ids session_id wake_count
  created_at_ms="$(date -u +%s%3N)"
  event_json="{\"id\":\"deployment-maintenance-${created_at_ms}\",\"event_type\":\"ETGeneric\",\"created_at\":${created_at_ms},\"origin\":null}"
  session_ids="$("${redis[@]}" SMEMBERS echo-sessions)"
  wake_count=0

  while IFS= read -r session_id; do
    [[ -n "$session_id" ]] || continue
    [[ "$session_id" =~ ^[0-9a-fA-F-]{36}$ ]] || continue
    if [[ "$("${redis[@]}" EXISTS "echo-sess-${session_id}")" != "1" ]]; then
      continue
    fi
    "${redis[@]}" XADD "echo-stream:${session_id}" MAXLEN '~' 1000 '*' v "$event_json" >/dev/null
    wake_count=$((wake_count + 1))
  done <<<"$session_ids"

  echo "Woke $wake_count active event streams."
}

case "$action" in
  start)
    marker="$(date -u +%Y%m%dT%H%M%S)-$$"
    "${redis[@]}" SET "$maintenance_key" "$marker" EX "$maintenance_ttl_seconds" >/dev/null

    marker_actual="$("${redis[@]}" GET "$maintenance_key")"
    ttl_ms="$("${redis[@]}" PTTL "$maintenance_key")"
    ttl_max_ms=$((maintenance_ttl_seconds * 1000))
    if [[ "$marker_actual" != "$marker" || ! "$ttl_ms" =~ ^[0-9]+$ || "$ttl_ms" -le 0 || "$ttl_ms" -gt "$ttl_max_ms" ]]; then
      "${redis[@]}" DEL "$maintenance_key" >/dev/null || true
      echo "Failed to verify deployment maintenance Redis key." >&2
      exit 1
    fi

    wake_event_streams
    echo "Deployment maintenance enabled for at most ${maintenance_ttl_seconds}s (PTTL=${ttl_ms}ms)."
    sleep 2
    ;;
  clear)
    "${redis[@]}" DEL "$maintenance_key" >/dev/null
    wake_event_streams
    echo "Deployment maintenance cleared."
    ;;
  renew)
    [[ "$("${redis[@]}" EXPIRE "$maintenance_key" "$maintenance_ttl_seconds")" == "1" ]]
    ;;
  *)
    echo "unknown action: $action" >&2
    exit 1
    ;;
esac
REMOTE
