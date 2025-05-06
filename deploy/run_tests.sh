#!/usr/bin/env bash
set -euo pipefail

# launch dev server in background
just dev-py &
DEV_PID=$!

# ensure dev server is killed on script exit (success or failure)
trap 'kill "$DEV_PID" 2>/dev/null || true' EXIT

# run tests in foreground; on failure script exits non-zero and trap runs
just test
