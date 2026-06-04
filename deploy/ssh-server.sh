#!/usr/bin/env bash
set -euo pipefail

server="${1:?missing server alias}"
log_name="${2:-}"

pids="$(lsof -tiTCP:6432 -sTCP:LISTEN || true)"
if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
fi

if [ -n "$log_name" ]; then
    exec >"/tmp/${log_name}-6432.log" 2>&1
fi

ssh -nNT -o ExitOnForwardFailure=yes -L 6432:localhost:5432 "$server"
