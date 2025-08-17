#!/bin/bash
set -e

CACHE_DIR="/tmp/cache/python"
PROJECT_DIR="wdintel-rs/wdintel-py"
REQUIREMENTS="$PROJECT_DIR/requirements.txt"
VENV_DIR="$PROJECT_DIR/.venv"

echo "💾 Saving Python cache..."

# Check if .venv exists
if [ ! -d "$VENV_DIR" ]; then
    echo "⚠️  No .venv directory found, skipping cache save"
    exit 0
fi

# Create cache directory
mkdir -p "$CACHE_DIR"

# Save .venv and requirements.txt
echo "📦 Copying .venv to cache..."
cp -r "$VENV_DIR" "$CACHE_DIR/"

echo "📄 Copying requirements.txt to cache..."
cp "$REQUIREMENTS" "$CACHE_DIR/"

echo "✅ Python cache saved successfully"
echo "📊 Cache size: $(du -sh "$CACHE_DIR" | cut -f1)"
