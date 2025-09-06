#!/bin/bash
set -euo pipefail

CACHE_ROOT="${ECHO_CI_CACHE_DIR:-$HOME/.cache/echo-ci}"
CACHE_DIR="$CACHE_ROOT/npm"
PROJECT_DIR="wdintel-web"
PACKAGE_LOCK="$PROJECT_DIR/package-lock.json"
NODE_MODULES="$PROJECT_DIR/node_modules"

echo "🔍 Checking for npm cache..."

# Create cache directory if it doesn't exist
mkdir -p "$CACHE_DIR"

# Check if cache exists and is valid
if [ -d "$CACHE_DIR/node_modules" ] && [ -f "$CACHE_DIR/package-lock.json" ]; then
    if cmp -s "$PACKAGE_LOCK" "$CACHE_DIR/package-lock.json"; then
        echo "✅ Restoring npm dependencies from local cache"
        rm -rf "$PROJECT_DIR/node_modules" 2>/dev/null || true
        rsync -a --delete "$CACHE_DIR/node_modules/" "$PROJECT_DIR/node_modules/"
        echo "📦 Cache restored successfully"
        exit 0
    else
        echo "⚠️  package-lock.json changed, cache invalid"
        rm -rf "$CACHE_DIR"/*
    fi
else
    echo "ℹ️  No npm cache found"
fi

echo "🚫 No valid cache available"
exit 1
