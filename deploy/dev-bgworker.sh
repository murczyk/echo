#!/usr/bin/env bash
set -euo pipefail

quiet="false"
log_sql="false"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pidfile="${repo_root}/.dev-pids/dev-bgworker.pid"

usage() {
    cat >&2 <<'EOF'
Usage:
  dev-bgworker [--quiet[=true|false]] [--log-sql[=true|false]] [--] [extra worker args...]
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
            echo "Unknown dev-bgworker option: $1" >&2
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
        *" --mode=debug bgworker "*|*" --mode=debug bgworker"|*" --mode=debug bgworker;"*)
            return 0
            ;;
    esac
    return 1
}

stop_existing_bgworker() {
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

run_bgworker() {
    local worker_args=("$@")
    local cmd='cd "$REPO_ROOT/wdintel-rs" && RUST_BACKTRACE=0 cargo watch -- cargo run -- --mode=debug bgworker "$@"'

    ensure_pid_dir
    stop_existing_bgworker

    if [ "$log_sql" = "true" ]; then
        export RUST_LOG=sqlx=trace,seaorm=trace
    fi

    if [ "$quiet" = "true" ]; then
        export RUST_LOG=${RUST_LOG:-error}
        echo "backend bgworker is running in quiet mode; only build errors and panics will be shown" >&2
    fi

    setsid env REPO_ROOT="$repo_root" bash -lc "$cmd" bash "${worker_args[@]}" &
    local pid=$!
    echo "$pid" > "$pidfile"

    cleanup() {
        rm -f "$pidfile"
    }
    trap cleanup EXIT INT TERM

    wait "$pid"
}

cd "$repo_root"
run_bgworker "$@"
