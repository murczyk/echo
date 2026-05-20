#!/usr/bin/env bash
set -euo pipefail

pgpwd="${1:?missing postgres password}"

pids="$(lsof -tiTCP:6432 -sTCP:LISTEN || true)"
if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
fi

ssh -nNT -o ExitOnForwardFailure=yes -L 6432:localhost:5432 echo-pivnich-dev >/tmp/dev-north-6432.log 2>&1 &
tunnel_pid=$!
trap 'kill "$tunnel_pid" 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 20); do
    if ! kill -0 "$tunnel_pid" 2>/dev/null; then
        wait "$tunnel_pid" || true
        echo "failed to establish SSH tunnel on :6432" >&2
        exit 1
    fi
    if lsof -a -p "$tunnel_pid" -iTCP:6432 -sTCP:LISTEN >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
done

PGPASSWORD="$pgpwd" psql -U wd -h 127.0.0.1 -p 6432 wd
