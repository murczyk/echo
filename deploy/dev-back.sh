#!/usr/bin/env bash
set -euo pipefail

verbose="${1:-true}"
log_sql="${2:-false}"
shift 2 || true

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pids="$(lsof -tiTCP:8081 -sTCP:LISTEN || true)"
if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
fi

cd "$repo_root/wdintel-rs"
if [ "$verbose" = "false" ]; then
    export RUST_LOG=error
elif [ "$log_sql" = "true" ]; then
    export RUST_LOG=sqlx=trace,seaorm=trace
fi

if [ "$verbose" = "false" ]; then
    server_port="${ECHO_SERVER_PORT:-8081}"
    echo "backend is running in silent mode on port ${server_port}, only REST API errors will be shown" >&2
    RUST_BACKTRACE=0 cargo watch -- cargo run -- --mode=debug server "$@" 2>&1 | awk '
        function is_rest_error(line) {
            return line ~ /Internal server error:/ ||
                line ~ /Service unavailable during shutdown:/ ||
                line ~ /not_found_details/ ||
                line ~ /unauthenticated_details/ ||
                line ~ /forbidden_details/ ||
                line ~ /form_error_details/ ||
                line ~ /business_error/
        }

        function is_continuation(line) {
            return line ~ /^[[:space:]]/ ||
                line ~ /^Caused by:/ ||
                line ~ /^[0-9]+:/
        }

        {
            if (is_rest_error($0)) {
                print
                keep = 1
                next
            }

            if (keep && is_continuation($0)) {
                print
                next
            }

            keep = 0
        }
    '
else
    RUST_BACKTRACE=0 cargo watch -- cargo run -- --mode=debug server "$@"
fi
