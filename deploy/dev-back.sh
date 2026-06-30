#!/usr/bin/env bash
set -euo pipefail

quiet="false"
log_sql="false"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
    cat >&2 <<'EOF'
Usage:
  dev-back [--quiet[=true|false]] [--log-sql[=true|false]] [--] [extra server args...]

Examples:
  dev-back
  dev-back --quiet
  dev-back --quiet=true
  dev-back --quiet=false
  dev-back --log-sql
  dev-back --quiet -- --some-server-arg
EOF
}

parse_bool() {
    case "$1" in
        true|false)
            printf '%s\n' "$1"
            ;;
        *)
            echo "Invalid boolean value: $1. Expected true or false." >&2
            exit 2
            ;;
    esac
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --quiet)
            quiet="true"
            shift
            ;;
        --quiet=*)
            quiet="$(parse_bool "${1#*=}")"
            shift
            ;;
        --log-sql)
            log_sql="true"
            shift
            ;;
        --log-sql=*)
            log_sql="$(parse_bool "${1#*=}")"
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        --)
            shift
            break
            ;;
        --*)
            echo "Unknown dev-back option: $1" >&2
            usage
            exit 2
            ;;
        *)
            break
            ;;
    esac
done

stop_existing_server() {
    local pids
    local server_port="${ECHO_SERVER_PORT:-8081}"

    pids="$(lsof -tiTCP:"${server_port}" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        kill $pids 2>/dev/null || true
    fi
}

filter_quiet_output() {
    awk '
        function is_http_error(line) {
            return line ~ /access_log/ &&
                line ~ /status=[45][0-9][0-9]/
        }

        function is_build_error(line, lower) {
            lower = tolower(line)
            return lower ~ /^error(\[[^]]+\])?:/ ||
                lower ~ /^error: /
        }

        function is_build_continuation(line) {
            return line ~ /^[[:space:]]/ ||
                line ~ /^= note:/ ||
                line ~ /^= help:/ ||
                line ~ /^note:/ ||
                line ~ /^help:/
        }

        function is_panic(line) {
            return line ~ /^thread .* panicked at / ||
                line ~ /^panic:/
        }

        function emit(line) {
            print line
            fflush()
        }

        {
            if (is_http_error($0)) {
                emit($0)
                keep_continuation = 0
                next
            }

            if (is_build_error($0)) {
                emit($0)
                keep_continuation = 1
                next
            }

            if (is_panic($0)) {
                emit($0)
                keep_continuation = 1
                next
            }

            if (keep_continuation && is_build_continuation($0)) {
                emit($0)
                next
            }

            keep_continuation = 0
        }
    '
}

run_server() {
    RUST_BACKTRACE=0 cargo watch -- cargo run -- --mode=debug server "$@"
}

stop_existing_server

cd "$repo_root/wdintel-rs"

if [ "$quiet" = "true" ]; then
    export ECHO_DEV_BACK_REST_ONLY=true
    export RUST_LOG=error,access_log=info

    server_port="${ECHO_SERVER_PORT:-8081}"
    echo "starting backend in quiet mode on port ${server_port}; only HTTP 4xx/5xx responses, build errors, and panics will be shown after startup" >&2

    run_server --no-bgworker "$@" 2>&1 | filter_quiet_output
else
    if [ "$log_sql" = "true" ]; then
        export RUST_LOG=sqlx=trace,seaorm=trace
    fi

    server_port="${ECHO_SERVER_PORT:-8081}"
    echo "starting backend on port ${server_port}..." >&2
    run_server "$@"
fi
