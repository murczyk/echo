#!/bin/bash
set -euo pipefail

CACHE_ROOT="${ECHO_CI_CACHE_DIR:-$HOME/.cache/echo-ci}"
CACHE_DIR="$CACHE_ROOT/npm"
PROJECT_DIR="wdintel-web"
PACKAGE_LOCK="$PROJECT_DIR/package-lock.json"
NODE_MODULES="$PROJECT_DIR/node_modules"

echo "💾 Saving npm cache..."

# Check if node_modules exists
if [ ! -d "$NODE_MODULES" ]; then
    echo "⚠️  No node_modules directory found, skipping cache save"
    exit 0
fi

mkdir -p "$CACHE_DIR"

# Reset destination to avoid accumulation of stale files
rm -rf "$CACHE_DIR/node_modules" 2>/dev/null || true

# Save node_modules and package-lock.json using rsync for speed and correctness
echo "📦 Syncing node_modules to cache..."
rsync -a --delete "$NODE_MODULES/" "$CACHE_DIR/node_modules/"

echo "📄 Saving package-lock.json to cache..."
cp -f "$PACKAGE_LOCK" "$CACHE_DIR/package-lock.json"

echo "✅ npm cache saved successfully"
echo "📊 Cache size: $(du -sh "$CACHE_DIR" | cut -f1)"
