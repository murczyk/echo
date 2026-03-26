#!/bin/bash
set -euo pipefail

CACHE_ROOT="${ECHO_CI_CACHE_DIR:-$HOME/.cache/echo-ci}"
CACHE_DIR="$CACHE_ROOT/pip"
PIP_CACHE="$HOME/.cache/pip"

echo "🔍 Checking for pip cache..."

mkdir -p "$CACHE_DIR"

if [ -d "$CACHE_DIR" ] && [ "$(ls -A "$CACHE_DIR" 2>/dev/null)" ]; then
    echo "✅ Restoring pip cache from local cache"
    mkdir -p "$PIP_CACHE"
    rsync -a --delete "$CACHE_DIR/" "$PIP_CACHE/"
    echo "📦 Cache restored successfully"
    exit 0
else
    echo "ℹ️  No pip cache found"
fi

echo "🚫 No valid cache available"
exit 1
