#!/bin/bash
set -euo pipefail

CACHE_ROOT="${ECHO_CI_CACHE_DIR:-$HOME/.cache/echo-ci}"
CACHE_DIR="$CACHE_ROOT/python"
PROJECT_DIR="wdintel-rs/wdintel-py"
REQUIREMENTS="$PROJECT_DIR/requirements.txt"
VENV_DIR="$PROJECT_DIR/.venv"

echo "🔍 Checking for Python cache..."

# Create cache directory if it doesn't exist
mkdir -p "$CACHE_DIR"

# Check if cache exists and is valid
if [ -d "$CACHE_DIR/.venv" ] && [ -f "$CACHE_DIR/requirements.txt" ]; then
    if cmp -s "$REQUIREMENTS" "$CACHE_DIR/requirements.txt"; then
        echo "✅ Restoring Python venv from local cache"
        rm -rf "$PROJECT_DIR/.venv" 2>/dev/null || true
        rsync -a --delete "$CACHE_DIR/.venv/" "$PROJECT_DIR/.venv/"
        echo "📦 Cache restored successfully"
        exit 0
    else
        echo "⚠️  requirements.txt changed, cache invalid"
        rm -rf "$CACHE_DIR"/*
    fi
else
    echo "ℹ️  No Python cache found"
fi

echo "🚫 No valid cache available"
exit 1
