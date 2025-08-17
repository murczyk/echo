#!/usr/bin/env bash
set -euo pipefail

echo "Starting CI test run with optimized dependency management..."

# Check if we're in CI environment
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "Running in GitHub Actions CI environment"

    # launch dev server in background for CI as well
    just dev-py &
    DEV_PID=$!

    # ensure dev server is killed on script exit (success or failure)
    trap 'kill "$DEV_PID" 2>/dev/null || true' EXIT

    # wait a moment for the Python service to start up
    echo "Waiting for Python service to start..."
    sleep 5

    # Use optimized CI test recipe
    just test-ci
else
    echo "Running in local environment"

    # launch dev server in background
    just dev-py &
    DEV_PID=$!

    # ensure dev server is killed on script exit (success or failure)
    trap 'kill "$DEV_PID" 2>/dev/null || true' EXIT

    # run tests in foreground; on failure script exits non-zero and trap runs
    just test
fi

echo "All tests completed successfully!"
