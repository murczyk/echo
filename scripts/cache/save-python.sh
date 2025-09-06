#!/bin/bash
set -euo pipefail

CACHE_ROOT="${ECHO_CI_CACHE_DIR:-$HOME/.cache/echo-ci}"
CACHE_DIR="$CACHE_ROOT/python"
PROJECT_DIR="wdintel-rs/wdintel-py"
REQUIREMENTS="$PROJECT_DIR/requirements.txt"
VENV_DIR="$PROJECT_DIR/.venv"

echo "💾 Saving Python cache..."

# Check if .venv exists
if [ ! -d "$VENV_DIR" ]; then
    echo "⚠️  No .venv directory found, skipping cache save"
    exit 0
fi

mkdir -p "$CACHE_DIR"

# Reset destination to avoid stale venv contents
rm -rf "$CACHE_DIR/.venv" 2>/dev/null || true

echo "📦 Syncing .venv to cache..."
rsync -a --delete "$VENV_DIR/" "$CACHE_DIR/.venv/"

echo "📄 Saving requirements.txt to cache..."
cp -f "$REQUIREMENTS" "$CACHE_DIR/requirements.txt"

echo "✅ Python cache saved successfully"
echo "📊 Cache size: $(du -sh "$CACHE_DIR" | cut -f1)"
