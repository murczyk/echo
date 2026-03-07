#!/usr/bin/env bash
set -euo pipefail

echo "Running backend tests with Python service..."

ensure_postgres_running() {
    local pg_host="${PG_HOST:-localhost}"
    local pg_port="${PG_PORT:-5432}"
    local pg_user="${PG_USER:-wd}"
    local pg_password="${PG_PASSWORD:-fee_-_-_-FnoeKFBeebu87bf}"
    local pg_db="${PG_DATABASE:-postgres}"
    local wait_secs="${POSTGRES_BOOT_WAIT_SECS:-300}"
    local i
    export PGPASSWORD="$pg_password"

    if psql -w -h "$pg_host" -p "$pg_port" -U "$pg_user" -d "$pg_db" -tAc "SELECT 1" >/dev/null 2>&1; then
        echo "PostgreSQL is already reachable at ${pg_host}:${pg_port}"
        return 0
    fi

    # Auto-start only for local default CI topology.
    if [[ "$pg_host" != "localhost" && "$pg_host" != "127.0.0.1" ]] || [[ "$pg_port" != "5432" ]]; then
        echo "PostgreSQL is not reachable at ${pg_host}:${pg_port}; skipping auto-start for non-local host/port"
        return 0
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
            return 0
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
            return 0
        fi
        sleep 1
    done

    echo "Warning: PostgreSQL remains not query-ready after restart attempts"
    if command -v pg_isready >/dev/null 2>&1; then
        pg_isready -h "$pg_host" -p "$pg_port" -U "$pg_user" || true
    fi
}

ensure_postgres_running

# CI boxes may require extra time while PostgreSQL replays WAL / crash-recovery.
export POSTGRES_STARTUP_TIMEOUT_SECS="${POSTGRES_STARTUP_TIMEOUT_SECS:-600}"

# Set up branch-specific test database
echo "Setting up test database..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
source "$SCRIPT_DIR/setup_test_database.sh"

# Export the database name for tests
export TEST_DB_NAME="$DB_NAME"
echo "Using test database: $TEST_DB_NAME"

# Create storage directory and dummy files for CI
mkdir -p ~/Downloads/storage
touch ~/Downloads/storage/wiki.model
touch ~/Downloads/storage/callsigns20230512.pt

# Reuse Cargo artifacts between `just test-be` (runs in `wdintel-rs/`) and later `cargo build`/`cargo deb`
# (run from repo root during packaging).
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    export CARGO_TARGET_DIR="$REPO_ROOT/target"
fi

# Launch Python service in background
just dev-py &
DEV_PID=$!

# Ensure dev server is killed on script exit (success or failure)
trap 'kill "$DEV_PID" 2>/dev/null || true' EXIT

# Wait for the service to be ready
PY_SERVICE_STARTUP_TIMEOUT_SECS="${PY_SERVICE_STARTUP_TIMEOUT_SECS:-240}"
echo "Waiting for Python service to start..."
for ((i = 1; i <= PY_SERVICE_STARTUP_TIMEOUT_SECS; i++)); do
    if curl -s http://127.0.0.1:5000/ > /dev/null 2>&1; then
        echo "Python service is ready!"
        break
    fi
    if [[ $i -eq "$PY_SERVICE_STARTUP_TIMEOUT_SECS" ]]; then
        echo "Python service failed to start within ${PY_SERVICE_STARTUP_TIMEOUT_SECS} seconds"
        exit 1
    fi
    sleep 1
done

# Run backend tests
echo "Running backend tests..."
just test-be

echo "Backend tests completed successfully!"
