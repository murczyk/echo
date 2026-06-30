#!/usr/bin/env bash
set -euo pipefail

quiet="false"
log_sql="false"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
pidfile="${repo_root}/.dev-pids/dev-back.pid"
server_port="${ECHO_SERVER_PORT:-8081}"

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

stop_pid_and_group() {
    local pid="$1"

    kill -TERM -- "-$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$pid" 2>/dev/null || true
    kill -KILL "$pid" 2>/dev/null || true
}

pid_exists() {
    kill -0 "$1" 2>/dev/null
}

pid_cmdline() {
    local pid="$1"

    if [ -r "/proc/$pid/cmdline" ]; then
        tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true
        return 0
    fi

    ps -p "$pid" -o args= 2>/dev/null || true
}

pid_cwd() {
    local pid="$1"
    local cwd

    if [ -e "/proc/$pid/cwd" ]; then
        readlink -f "/proc/$pid/cwd" 2>/dev/null || true
        return 0
    fi

    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
    if [ -n "$cwd" ]; then
        (cd "$cwd" 2>/dev/null && pwd -P) || true
    fi
}

is_expected_process() {
    local pid="$1"
    local cwd cmdline

    pid_exists "$pid" || return 1

    cwd="$(pid_cwd "$pid")"
    if [ -n "$cwd" ] && [ "$cwd" != "${repo_root}/wdintel-rs" ]; then
        return 1
    fi

    cmdline="$(pid_cmdline "$pid")"
    case "$cmdline" in
        *" --mode=debug server --no-bgworker "*|*" --mode=debug server --no-bgworker"|*" --mode=debug server --no-bgworker;"*)
            return 0
            ;;
    esac

    return 1
}

stop_port_listener_fallback() {
    local pid

    for pid in $(lsof -tiTCP:"$server_port" -sTCP:LISTEN 2>/dev/null || true); do
        if is_expected_process "$pid"; then
            stop_pid_and_group "$pid"
        else
            echo "refusing to kill unexpected process $pid listening on port $server_port" >&2
        fi
    done
}

stop_existing_server() {
    local pid

    if [ ! -f "$pidfile" ]; then
        stop_port_listener_fallback
        return 0
    fi

    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -z "$pid" ]; then
        rm -f "$pidfile"
        stop_port_listener_fallback
        return 0
    fi

    if is_expected_process "$pid"; then
        stop_pid_and_group "$pid"
        rm -f "$pidfile"
        return 0
    fi

    rm -f "$pidfile"
    stop_port_listener_fallback
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
    local pid
    local cmd='cd "$REPO_ROOT/wdintel-rs" && RUST_BACKTRACE=0 cargo watch -- cargo run -- --mode=debug server --no-bgworker "$@"'

    ensure_pid_dir
    stop_existing_server

    if [ "$quiet" = "true" ]; then
        export ECHO_DEV_BACK_REST_ONLY=true
        export RUST_LOG=error,access_log=info

        echo "starting backend in quiet mode on port ${server_port}; only HTTP 4xx/5xx responses, build errors, and panics will be shown" >&2
        echo "report workers run separately: just dev-bgworker" >&2

        setsid env REPO_ROOT="$repo_root" bash -lc "$cmd" bash "${server_args[@]}" > >(filter_quiet_output) 2>&1 &
    else
        if [ "$log_sql" = "true" ]; then
            export RUST_LOG=sqlx=trace,seaorm=trace
        fi

        echo "starting backend on port ${server_port}..." >&2
        echo "report workers run separately: just dev-bgworker" >&2

        setsid env REPO_ROOT="$repo_root" bash -lc "$cmd" bash "${server_args[@]}" &
    fi

    pid=$!
    echo "$pid" > "$pidfile"

    cleanup() {
        if is_expected_process "$pid"; then
            stop_pid_and_group "$pid"
        fi
        rm -f "$pidfile"
    }

    trap cleanup EXIT INT TERM

    wait "$pid"
}

cd "$repo_root"
run_server "$@"
