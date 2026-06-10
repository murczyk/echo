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
    export ECHO_DEV_BACK_REST_ONLY=true
    export RUST_LOG=error,access_log=info
    server_args+=(--no-bgworker)
elif [ "$log_sql" = "true" ]; then
    export RUST_LOG=sqlx=trace,seaorm=trace
fi

if [ "$verbose" = "false" ]; then
    server_port="${ECHO_SERVER_PORT:-8081}"
    echo "backend is running in silent mode on port ${server_port}, only 4xx/5xx HTTP responses and build errors will be shown" >&2
    if [ "${#server_args[@]}" -gt 0 ]; then
        RUST_BACKTRACE=0 cargo watch -- cargo run -- --mode=debug server "${server_args[@]}" "$@" 2>&1 | awk '
        function is_http_error(line) {
            return line ~ /access_log/ &&
                line ~ /status=[45][0-9][0-9]/
        }

        function is_build_error(line) {
            line = tolower(line)
            return line ~ /^error(\[[^]]+\])?:/ ||
                line ~ /^error: /
        }

        function is_build_continuation(line) {
            return line ~ /^[[:space:]]/ ||
                line ~ /^= note:/ ||
                line ~ /^= help:/ ||
                line ~ /^note:/ ||
                line ~ /^help:/
        }

        {
            if (is_http_error($0)) {
                print
                build_keep = 0
                next
            }

            if (is_build_error($0)) {
                print
                build_keep = 1
                next
            }

            if (build_keep && is_build_continuation($0)) {
                print
                next
            }

            build_keep = 0
        }
    '
    else
        RUST_BACKTRACE=0 cargo watch -- cargo run -- --mode=debug server "$@" 2>&1 | awk '
        function is_http_error(line) {
            return line ~ /access_log/ &&
                line ~ /status=[45][0-9][0-9]/
        }

        function is_build_error(line) {
            line = tolower(line)
            return line ~ /^error(\[[^]]+\])?:/ ||
                line ~ /^error: /
        }

        function is_build_continuation(line) {
            return line ~ /^[[:space:]]/ ||
                line ~ /^= note:/ ||
                line ~ /^= help:/ ||
                line ~ /^note:/ ||
                line ~ /^help:/
        }

        {
            if (is_http_error($0)) {
                print
                build_keep = 0
                next
            }

            if (is_build_error($0)) {
                print
                build_keep = 1
                next
            }

            if (build_keep && is_build_continuation($0)) {
                print
                next
            }

            build_keep = 0
        }
    '
    fi
else
    if [ "${#server_args[@]}" -gt 0 ]; then
        RUST_BACKTRACE=0 cargo watch -- cargo run -- --mode=debug server "${server_args[@]}" "$@"
    else
        RUST_BACKTRACE=0 cargo watch -- cargo run -- --mode=debug server "$@"
    fi
fi
