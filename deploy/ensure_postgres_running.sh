#!/usr/bin/env bash
set -euo pipefail

pg_host="${PG_HOST:-localhost}"
pg_port="${PG_PORT:-5432}"
pg_user="${PG_USER:-wd}"
pg_password="${PG_PASSWORD:-fee_-_-_-FnoeKFBeebu87bf}"
pg_db="${PG_DATABASE:-postgres}"
wait_secs="${POSTGRES_BOOT_WAIT_SECS:-300}"

export PGPASSWORD="$pg_password"
last_psql_error=""

run_with_optional_sudo() {
    if command -v sudo >/dev/null 2>&1; then
        sudo -n "$@" || true
    else
        "$@" || true
    fi
}

run_pg_ctlcluster_action() {
    local action="$1"
    local cluster_version=""
    local cluster_name=""

    if command -v pg_lsclusters >/dev/null 2>&1; then
        # Prefer a running cluster first, otherwise pick the first available one.
        local cluster_line
        cluster_line="$(pg_lsclusters 2>/dev/null | awk 'NR>1 && $4 == "online" {print $1 " " $2; exit}')"
        if [[ -z "$cluster_line" ]]; then
            cluster_line="$(pg_lsclusters 2>/dev/null | awk 'NR>1 {print $1 " " $2; exit}')"
        fi
        if [[ -n "$cluster_line" ]]; then
            cluster_version="$(awk '{print $1}' <<<"$cluster_line")"
            cluster_name="$(awk '{print $2}' <<<"$cluster_line")"
        fi
    fi

    if [[ -n "$cluster_version" && -n "$cluster_name" ]]; then
        run_with_optional_sudo pg_ctlcluster "$cluster_version" "$cluster_name" "$action"
        return
    fi

    # Fallback to the project default if cluster discovery is unavailable.
    run_with_optional_sudo pg_ctlcluster 18 main "$action"
}

check_query_ready() {
    if psql -w -h "$pg_host" -p "$pg_port" -U "$pg_user" -d "$pg_db" -tAc "SELECT 1" >/dev/null 2>&1; then
        last_psql_error=""
        return 0
    fi
    last_psql_error="$(psql -w -h "$pg_host" -p "$pg_port" -U "$pg_user" -d "$pg_db" -tAc "SELECT 1" 2>&1 >/dev/null || true)"
    return 1
}

is_non_retryable_auth_error() {
    local error_text="$1"
    [[ "$error_text" == *"password authentication failed"* ]] || \
        [[ "$error_text" == *"role \""* && "$error_text" == *"does not exist"* ]] || \
        [[ "$error_text" == *"no pg_hba.conf entry"* ]]
}

if check_query_ready; then
    echo "PostgreSQL is already reachable at ${pg_host}:${pg_port}"
    exit 0
fi

# Auto-start only for local default CI topology.
if [[ "$pg_host" != "localhost" && "$pg_host" != "127.0.0.1" ]] || [[ "$pg_port" != "5432" ]]; then
    echo "PostgreSQL is not reachable at ${pg_host}:${pg_port}; skipping auto-start for non-local host/port"
    exit 0
fi

echo "PostgreSQL is not reachable at ${pg_host}:${pg_port}; attempting to start local service..."

if command -v systemctl >/dev/null 2>&1; then
    run_with_optional_sudo systemctl start postgresql
fi

if ! check_query_ready; then
    if command -v pg_ctlcluster >/dev/null 2>&1; then
        run_pg_ctlcluster_action start
    fi
fi

if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -h "$pg_host" -p "$pg_port" -U "$pg_user" || true
fi

echo "Waiting for PostgreSQL to become query-ready (up to ${wait_secs}s)..."
for ((i = 1; i <= wait_secs; i++)); do
    if check_query_ready; then
        echo "PostgreSQL became query-ready"
        exit 0
    fi
    if is_non_retryable_auth_error "$last_psql_error"; then
        echo "Error: PostgreSQL connection failed with a non-retryable auth/config error:"
        echo "$last_psql_error"
        exit 1
    fi
    sleep 1
done

echo "PostgreSQL is still not query-ready after initial start attempt; retrying one restart..."
if command -v systemctl >/dev/null 2>&1; then
    run_with_optional_sudo systemctl restart postgresql
    run_with_optional_sudo systemctl --no-pager --full status postgresql
elif command -v pg_ctlcluster >/dev/null 2>&1; then
    run_pg_ctlcluster_action restart
fi

for ((i = 1; i <= wait_secs; i++)); do
    if check_query_ready; then
        echo "PostgreSQL became query-ready after restart"
        exit 0
    fi
    if is_non_retryable_auth_error "$last_psql_error"; then
        echo "Error: PostgreSQL connection failed with a non-retryable auth/config error:"
        echo "$last_psql_error"
        exit 1
    fi
    sleep 1
done

echo "Warning: PostgreSQL remains not query-ready after restart attempts"
if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -h "$pg_host" -p "$pg_port" -U "$pg_user" || true
fi
