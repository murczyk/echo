#!/usr/bin/env bash
set -euo pipefail

echo "Running backend tests with Python service..."

# Set up branch-specific test database
echo "Setting up test database..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/setup_test_database.sh"

# Export the database name for tests
export TEST_DB_NAME="$DB_NAME"
echo "Using test database: $TEST_DB_NAME"

# Create storage directory and dummy files for CI
mkdir -p ~/Downloads/storage
touch ~/Downloads/storage/wiki.model
touch ~/Downloads/storage/callsigns20230512.pt

# Launch Python service in background
just dev-py &
DEV_PID=$!

# Ensure dev server is killed on script exit (success or failure)
trap 'kill "$DEV_PID" 2>/dev/null || true' EXIT

# Wait for the service to be ready
echo "Waiting for Python service to start..."
for i in {1..120}; do
    if curl -s http://127.0.0.1:5000/ > /dev/null 2>&1; then
        echo "Python service is ready!"
        break
    fi
    if [ $i -eq 120 ]; then
        echo "Python service failed to start within 120 seconds"
        exit 1
    fi
    sleep 1
done

# Run backend tests
echo "Running backend tests..."
just test-be

echo "Backend tests completed successfully!"
