#!/usr/bin/env bash
set -euo pipefail

quiet="false"
log_sql="false"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pidfile="${repo_root}/.dev-pids/dev-back.pid"

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

ensure_pid_dir() {
    mkdir -p "$(dirname "$pidfile")"
}

is_expected_process() {
    local pid="$1"
    local cwd cmdline

    [ -d "/proc/$pid" ] || return 1
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    [ "$cwd" = "${repo_root}/wdintel-rs" ] || return 1

    cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$cmdline" in
        *" --mode=debug server "*|*" --mode=debug server"|*" --mode=debug server;"*)
            return 0
            ;;
    esac
    return 1
}

stop_existing_server() {
    local pid

    if [ ! -f "$pidfile" ]; then
        return 0
    fi

    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -z "$pid" ]; then
        rm -f "$pidfile"
        return 0
    fi

    if is_expected_process "$pid"; then
        kill -TERM -- "-$pid" 2>/dev/null || true
        sleep 1
        kill -KILL -- "-$pid" 2>/dev/null || true
    fi

    rm -f "$pidfile"
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
    local server_args=("$@")
    local cmd='cd "$REPO_ROOT/wdintel-rs" && RUST_BACKTRACE=0 cargo watch -- cargo run -- --mode=debug server "$@"'

    ensure_pid_dir
    stop_existing_server

    if [ "$quiet" = "true" ]; then
        export ECHO_DEV_BACK_REST_ONLY=true
        export RUST_LOG=error,access_log=info
        server_port="${ECHO_SERVER_PORT:-8081}"
        echo "backend is running in quiet mode on port ${server_port}; only HTTP 4xx/5xx responses, build errors, and panics will be shown" >&2
        echo "report workers run separately: just dev-bgworker" >&2

        setsid env REPO_ROOT="$repo_root" bash -lc "$cmd" bash "${server_args[@]}" > >(filter_quiet_output) 2>&1 &
    else
        if [ "$log_sql" = "true" ]; then
            export RUST_LOG=sqlx=trace,seaorm=trace
        fi
        echo "report workers run separately: just dev-bgworker" >&2

        setsid env REPO_ROOT="$repo_root" bash -lc "$cmd" bash "${server_args[@]}" &
    fi

    local pid=$!
    echo "$pid" > "$pidfile"

    cleanup() {
        rm -f "$pidfile"
    }
    trap cleanup EXIT INT TERM

    wait "$pid"
}

cd "$repo_root"
run_server "$@"
