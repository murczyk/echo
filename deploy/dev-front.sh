#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

cd "${repo_root}/wdintel-web"

npx elm-land server &
server_pid=$!

cleanup() {
    kill "${server_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

synced=0
for _ in $(seq 1 60); do
    if bash "${repo_root}/deploy/sync-dev-front-nginx.sh" "${server_pid}"; then
        synced=1
        break
    fi
    sleep 1
done

if [[ "${synced}" -ne 1 ]]; then
    echo "Failed to sync nginx to the running Elm Land server." >&2
    exit 1
fi

wait "${server_pid}"
