#!/usr/bin/env bash
set -euo pipefail

echo "Running backend tests with Python service..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

bash "$SCRIPT_DIR/ensure_postgres_running.sh"

# CI boxes may require extra time while PostgreSQL replays WAL / crash-recovery.
export POSTGRES_STARTUP_TIMEOUT_SECS="${POSTGRES_STARTUP_TIMEOUT_SECS:-600}"

# Set up branch-specific test database
echo "Setting up test database..."
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
