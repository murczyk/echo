#!/usr/bin/env bash
set -euo pipefail

echo "Running backend tests with Python service..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

python3 -m unittest scripts/ci/test_check_analytics_migrations.py
python3 scripts/ci/check_analytics_migrations.py
bash deploy/clickhouse/tests/test-resnapshot-table.sh
bash deploy/clickhouse/tests/test-manage-system-logs.sh
bash deploy/clickhouse/tests/test-source-verify-deploy.sh

bash "$SCRIPT_DIR/ensure_postgres_running.sh"
bash deploy/clickhouse/tests/test-analytics-schema-reconcile-lock.sh

# CI boxes may require extra time while PostgreSQL replays WAL / crash-recovery.
export POSTGRES_STARTUP_TIMEOUT_SECS="${POSTGRES_STARTUP_TIMEOUT_SECS:-600}"

# Set up branch-specific test database
echo "Setting up test database..."
source "$SCRIPT_DIR/setup_test_database.sh"

# Export the database names for tests
export TEST_DB_NAME="$DB_NAME"
export TEST_WDFILE_DB_NAME="$FILE_REGISTRY_DB_NAME"
echo "Using test databases: $TEST_DB_NAME and $TEST_WDFILE_DB_NAME"

bash "$REPO_ROOT/scripts/ci/check_analytics_migration_catalog.sh"
echo "Migrating test databases..."
cargo run -p wdintel-rs -- --mode=test migrate

# Create storage directory and dummy files for CI
mkdir -p ~/Downloads/storage
touch ~/Downloads/storage/wiki.model
touch ~/Downloads/storage/callsigns20230512.pt

# Reuse Cargo artifacts between `just test-be` (runs in `wdintel-rs/`) and later `cargo build`/`cargo deb`
# (run from repo root during packaging).
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    export CARGO_TARGET_DIR="$REPO_ROOT/target"
fi

# Launch Python service in a separate process group so CI teardown can stop it cleanly.
PY_SERVICE_LOG_DIR="$REPO_ROOT/target"
PY_SERVICE_LOG="$PY_SERVICE_LOG_DIR/dev-py.log"
mkdir -p "$PY_SERVICE_LOG_DIR"
: > "$PY_SERVICE_LOG"

setsid just dev-py >>"$PY_SERVICE_LOG" 2>&1 &
DEV_PGID=$!

cleanup_dev_py() {
    local exit_status=$?
    kill -- "-$DEV_PGID" 2>/dev/null || true
    wait "$DEV_PGID" 2>/dev/null || true
    if [[ $exit_status -ne 0 ]]; then
        echo "Last dev-py log lines:"
        tail -n 50 "$PY_SERVICE_LOG" || true
    fi
    exit "$exit_status"
}

trap cleanup_dev_py EXIT

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
TEST_DB_NAME="$TEST_DB_NAME" TEST_WDFILE_DB_NAME="$TEST_WDFILE_DB_NAME" just test-be

echo "Backend tests completed successfully!"
