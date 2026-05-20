#!/usr/bin/env bash
set -euo pipefail

verbose="${1:-true}"
log_sql="${2:-false}"
shift 2 || true
server_args=()

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pids="$(lsof -tiTCP:8081 -sTCP:LISTEN || true)"
if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
fi

cd "$repo_root/wdintel-rs"
if [ "$verbose" = "false" ]; then
    export RUST_LOG=error
    server_args+=(--no-bgworker)
elif [ "$log_sql" = "true" ]; then
    export RUST_LOG=sqlx=trace,seaorm=trace
fi

RUST_BACKTRACE=0 cargo watch -- cargo run -- --mode=debug server "${server_args[@]}" "$@"
