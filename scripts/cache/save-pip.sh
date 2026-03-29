#!/bin/bash
set -euo pipefail

CACHE_ROOT="${ECHO_CI_CACHE_DIR:-$HOME/.cache/echo-ci}"
CACHE_DIR="$CACHE_ROOT/pip"
PIP_CACHE="$HOME/.cache/pip"

echo "💾 Saving pip cache..."

if [ ! -d "$PIP_CACHE" ]; then
    echo "ℹ️  No pip cache directory found, skipping cache save"
    exit 0
fi

if [ ! "$(ls -A "$PIP_CACHE" 2>/dev/null)" ]; then
    echo "ℹ️  pip cache is empty, skipping cache save"
    exit 0
fi

mkdir -p "$CACHE_DIR"

echo "📦 Syncing pip cache to local cache..."
rsync -a --delete "$PIP_CACHE/" "$CACHE_DIR/"

echo "✅ pip cache saved successfully"
echo "📊 Cache size: $(du -sh "$CACHE_DIR" | cut -f1)"
