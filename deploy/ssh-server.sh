#!/usr/bin/env bash
set -euo pipefail

server="${1:?missing server alias}"
log_name="${2:-}"
host="${SSH_TUNNEL_HOST:-127.0.0.1}"
port="${SSH_TUNNEL_PORT:-6432}"
db_user="${SSH_TUNNEL_DB_USER:-wd}"
db_name="${SSH_TUNNEL_DB_NAME:-wd}"
db_password="${SSH_TUNNEL_DB_PASSWORD:-fee_-_-_-FnoeKFBeebu87bf}"
wait_secs="${SSH_TUNNEL_WAIT_SECS:-30}"
require_db_health="${SSH_TUNNEL_REQUIRE_DB_HEALTH:-false}"

pids="$(lsof -tiTCP:${port} -sTCP:LISTEN || true)"
if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
fi

if [ -n "$log_name" ]; then
    exec > >(tee "/tmp/${log_name}-${port}.log") 2>&1
fi

wait_for_port() {
    local i
    for i in $(seq 1 "$wait_secs"); do
        if bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null; then
            exec 3>&-
            exec 3<&-
            return 0
        fi
        sleep 1
    done
    return 1
}

check_db_health() {
    if ! command -v psql >/dev/null 2>&1; then
        echo "psql is required to verify DB health. Install postgresql-client." >&2
        return 1
    fi

    PGPASSWORD="$db_password" psql \
        -w \
        -h "$host" \
        -p "$port" \
        -U "$db_user" \
        -d "$db_name" \
        -tAc "SELECT 1" >/dev/null
}

db_health_is_required() {
    case "$require_db_health" in
        1|true|TRUE|yes|YES|on|ON)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

ssh -nNT -o ExitOnForwardFailure=yes -L "${port}:localhost:5432" "$server" &
ssh_pid=$!

cleanup() {
    kill "$ssh_pid" 2>/dev/null || true
    wait "$ssh_pid" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

if ! wait_for_port; then
    echo "DB tunnel did not open on ${host}:${port} within ${wait_secs}s" >&2
    exit 1
fi

if db_health_output="$(check_db_health 2>&1)"; then
    echo "DB healthy at startup on ${host}:${port}; keep this process running for the tunnel" >&2
else
    if db_health_is_required; then
        echo "DB unhealthy on ${host}:${port}; closing tunnel" >&2
        [ -n "$db_health_output" ] && printf '%s\n' "$db_health_output" >&2
        exit 1
    fi

    echo "DB health check failed; tunnel is still running on ${host}:${port}" >&2
    [ -n "$db_health_output" ] && printf '%s\n' "$db_health_output" >&2
fi

wait "$ssh_pid"
