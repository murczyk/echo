#!/bin/bash
set -e

CACHE_DIR="/tmp/cache/npm"
PROJECT_DIR="wdintel-web"
PACKAGE_LOCK="$PROJECT_DIR/package-lock.json"
NODE_MODULES="$PROJECT_DIR/node_modules"

echo "💾 Saving npm cache..."

# Check if node_modules exists
if [ ! -d "$NODE_MODULES" ]; then
    echo "⚠️  No node_modules directory found, skipping cache save"
    exit 0
fi

# Create cache directory
mkdir -p "$CACHE_DIR"

# Save node_modules and package-lock.json
echo "📦 Copying node_modules to cache..."
cp -r "$NODE_MODULES" "$CACHE_DIR/"

echo "📄 Copying package-lock.json to cache..."
cp "$PACKAGE_LOCK" "$CACHE_DIR/"

echo "✅ npm cache saved successfully"
echo "📊 Cache size: $(du -sh "$CACHE_DIR" | cut -f1)"
