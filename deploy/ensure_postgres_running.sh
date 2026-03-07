#!/usr/bin/env bash
set -euo pipefail

pg_host="${PG_HOST:-localhost}"
pg_port="${PG_PORT:-5432}"
pg_user="${PG_USER:-wd}"
pg_password="${PG_PASSWORD:-fee_-_-_-FnoeKFBeebu87bf}"
pg_db="${PG_DATABASE:-postgres}"
wait_secs="${POSTGRES_BOOT_WAIT_SECS:-300}"

export PGPASSWORD="$pg_password"

if psql -w -h "$pg_host" -p "$pg_port" -U "$pg_user" -d "$pg_db" -tAc "SELECT 1" >/dev/null 2>&1; then
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
    if command -v sudo >/dev/null 2>&1; then
        sudo -n systemctl start postgresql || true
    else
        systemctl start postgresql || true
    fi
fi

if ! psql -w -h "$pg_host" -p "$pg_port" -U "${PG_USER:-wd}" -d "${PG_DATABASE:-postgres}" -tAc "SELECT 1" >/dev/null 2>&1; then
    if command -v pg_ctlcluster >/dev/null 2>&1; then
        if command -v sudo >/dev/null 2>&1; then
            sudo -n pg_ctlcluster 14 main start || true
        else
            pg_ctlcluster 14 main start || true
        fi
    fi
fi

if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -h "$pg_host" -p "$pg_port" -U "$pg_user" || true
fi

echo "Waiting for PostgreSQL to become query-ready (up to ${wait_secs}s)..."
for ((i = 1; i <= wait_secs; i++)); do
    if psql -w -h "$pg_host" -p "$pg_port" -U "$pg_user" -d "$pg_db" -tAc "SELECT 1" >/dev/null 2>&1; then
        echo "PostgreSQL became query-ready"
        exit 0
    fi
    sleep 1
done

echo "PostgreSQL is still not query-ready after initial start attempt; retrying one restart..."
if command -v systemctl >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1; then
        sudo -n systemctl restart postgresql || true
        sudo -n systemctl --no-pager --full status postgresql || true
    else
        systemctl restart postgresql || true
        systemctl --no-pager --full status postgresql || true
    fi
elif command -v pg_ctlcluster >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1; then
        sudo -n pg_ctlcluster 14 main restart || true
    else
        pg_ctlcluster 14 main restart || true
    fi
fi

for ((i = 1; i <= wait_secs; i++)); do
    if psql -w -h "$pg_host" -p "$pg_port" -U "$pg_user" -d "$pg_db" -tAc "SELECT 1" >/dev/null 2>&1; then
        echo "PostgreSQL became query-ready after restart"
        exit 0
    fi
    sleep 1
done

echo "Warning: PostgreSQL remains not query-ready after restart attempts"
if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -h "$pg_host" -p "$pg_port" -U "$pg_user" || true
fi
