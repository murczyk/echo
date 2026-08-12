#!/usr/bin/env bash
set -euo pipefail

quiet="false"
log_sql="false"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
pidfile="${repo_root}/.dev-runtime/dev-back.pid"
server_port="${ECHO_SERVER_PORT:-8081}"
server_ping_url="http://127.0.0.1:${server_port}/api/ping"
server_logfile="${repo_root}/.dev-runtime/dev-back.log"

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

# cargo / cargo-watch often move the server binary into its own process group,
# so killing only the session leader's group leaves wdintel-rs running after Ctrl+C.
list_descendant_pids() {
    local pid="$1"
    local child

    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
        list_descendant_pids "$child"
        printf '%s\n' "$child"
    done
}

unique_pids() {
    printf '%s\n' "$@" | awk 'NF && !seen[$0]++'
}

signal_pid_and_group() {
    local signal="$1"
    local pid="$2"

    kill "-$signal" -- "-$pid" 2>/dev/null || true
    kill "-$signal" "$pid" 2>/dev/null || true
}

stop_pids_and_groups() {
    local signal_wait_seconds="${1:-1}"
    shift
    local id
    local ids

    ids="$(unique_pids "$@")"
    [ -n "$ids" ] || return 0

    for id in $ids; do
        signal_pid_and_group TERM "$id"
    done
    # Signal delivery can interrupt sleep; never fail the stop path under `set -e`.
    sleep "$signal_wait_seconds" || true
    for id in $ids; do
        signal_pid_and_group KILL "$id"
    done
}

stop_pid_and_group() {
    local pid="$1"
    local ids
    local id

    ids="$(list_descendant_pids "$pid"; printf '%s\n' "$pid")"
    ids="$(unique_pids $ids)"

    for id in $ids; do
        signal_pid_and_group TERM "$id"
    done
    # Signal delivery can interrupt sleep; never fail the stop path under `set -e`.
    sleep 1 || true

    # Re-scan: cargo-watch may respawn the binary in a new process group after TERM.
    ids="$(unique_pids $ids $(list_descendant_pids "$pid") "$pid")"
    for id in $ids; do
        signal_pid_and_group KILL "$id"
    done
}

# Linux has `setsid`; macOS does not. Prefer setsid, else perl POSIX::setsid.
# IMPORTANT: this must `exec` so that `start_detached ... &` replaces the bash
# function subshell. Otherwise the subshell stays in the terminal process group,
# dies on Ctrl+C, and cleanup can no longer find/kill cargo's detached server.
start_detached() {
    if command -v setsid >/dev/null 2>&1; then
        exec setsid "$@"
    else
        exec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' -- "$@"
    fi
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

collect_expected_backend_pids() {
    local pid
    local self_pid=$$

    # Avoid `pgrep -f -- --mode=...`: macOS pgrep treats leading dashes as options.
    for pid in $(pgrep -f 'mode=debug server --no-bgworker' 2>/dev/null || true); do
        if [ "$pid" = "$self_pid" ]; then
            continue
        fi
        if is_expected_process "$pid"; then
            printf '%s\n' "$pid"
        fi
    done
}

stop_port_listener_fallback() {
    local pid
    local pids=""

    for pid in $(lsof -tiTCP:"$server_port" -sTCP:LISTEN 2>/dev/null || true); do
        if is_expected_process "$pid"; then
            pids="$pids $pid"
        else
            echo "refusing to kill unexpected process $pid listening on port $server_port" >&2
        fi
    done

    stop_pids_and_groups 1 $pids
}

stop_orphaned_expected_processes() {
    local pids

    pids="$(unique_pids $(collect_expected_backend_pids))"
    stop_pids_and_groups 1 $pids
}

stop_existing_server() {
    local pid

    if [ -f "$pidfile" ]; then
        pid="$(cat "$pidfile" 2>/dev/null || true)"
        if [ -n "$pid" ] && is_expected_process "$pid"; then
            stop_pid_and_group "$pid"
        fi
        rm -f "$pidfile"
    fi

    stop_port_listener_fallback
    stop_orphaned_expected_processes
}

server_is_ready() {
    curl --fail --silent --show-error --max-time 1 --noproxy '*' "$server_ping_url" \
        | grep -qx 'pong'
}

monitor_server_readiness() {
    local server_pid="$1"
    local was_ready="false"
    local seconds_waiting=0

    echo "waiting for backend readiness at ${server_ping_url}..." >&2

    while pid_exists "$server_pid"; do
        if server_is_ready 2>/dev/null; then
            if [ "$was_ready" != "true" ]; then
                echo "✅ backend READY: ${server_ping_url}" >&2
            fi
            was_ready="true"
            seconds_waiting=0
        else
            if [ "$was_ready" = "true" ]; then
                echo "⚠️ backend UNAVAILABLE: ${server_ping_url}; browser requests may return 502 until it is ready again" >&2
            fi
            was_ready="false"
            seconds_waiting=$((seconds_waiting + 1))
            if [ "$seconds_waiting" -eq 30 ]; then
                echo "⚠️ backend is still not ready after 30 seconds: ${server_ping_url}; check build errors above" >&2
            fi
        fi
        sleep 1
    done

    if [ "$was_ready" != "true" ]; then
        echo "❌ backend process exited before becoming ready: ${server_ping_url}" >&2
    fi
}

run_server() {
    local server_args=("$@")
    local pid
    local readiness_monitor_pid=""
    local follow_server_log="false"
    local server_log_tail_pid=""
    local cmd='cd "$REPO_ROOT/wdintel-rs" && RUST_BACKTRACE=0 cargo watch -- cargo run -- --mode=debug server --no-bgworker "$@"'

    ensure_pid_dir
    stop_existing_server

    if [ "$quiet" = "true" ]; then
        export ECHO_DEV_BACK_REST_ONLY=true
        export RUST_LOG=warn

        echo "starting backend in quiet mode on port ${server_port}; successful HTTP access logs are hidden" >&2

        : > "$server_logfile"
        # macOS bash 3.2 + `set -u`: expanding an empty `${array[@]}` is an error.
        start_detached env REPO_ROOT="$repo_root" bash -lc "$cmd" bash ${server_args[@]+"${server_args[@]}"} > "$server_logfile" 2>&1 &
        pid=$!
        follow_server_log="true"
    else
        if [ "$log_sql" = "true" ]; then
            export RUST_LOG=sqlx=trace,seaorm=trace
        fi

        echo "starting backend on port ${server_port}..." >&2

        start_detached env REPO_ROOT="$repo_root" bash -lc "$cmd" bash ${server_args[@]+"${server_args[@]}"} &
        pid=$!
    fi

    echo "$pid" > "$pidfile"

    # Keep readiness monitor out of the tty SIGINT process group side-effects.
    (
        trap '' INT
        monitor_server_readiness "$pid"
    ) &
    readiness_monitor_pid=$!

    cleanup() {
        # Ensure Ctrl+C / HUP mid-cleanup cannot abort via `set -e` (e.g. interrupted sleep).
        set +e
        if [ -n "$server_log_tail_pid" ]; then
            kill "$server_log_tail_pid" 2>/dev/null || true
            wait "$server_log_tail_pid" 2>/dev/null || true
        fi
        if [ -n "$readiness_monitor_pid" ]; then
            kill "$readiness_monitor_pid" 2>/dev/null || true
            wait "$readiness_monitor_pid" 2>/dev/null || true
        fi
        if pid_exists "$pid"; then
            stop_pid_and_group "$pid"
        fi
        # Only remove the pidfile if it still points at this instance (a replacement
        # `dev-back` may have already claimed it).
        if [ -f "$pidfile" ]; then
            if [ "$(cat "$pidfile" 2>/dev/null || true)" = "$pid" ]; then
                rm -f "$pidfile"
            fi
        fi
    }

    trap cleanup EXIT INT TERM HUP

    if [ "$follow_server_log" = "true" ]; then
        (
            trap '' INT
            tail -n +1 -f "$server_logfile"
        ) &
        server_log_tail_pid=$!
    fi

    if wait "$pid"; then
        :
    else
        exit $?
    fi
}

cd "$repo_root"
run_server "$@"
