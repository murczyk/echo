#!/bin/bash
set -euo pipefail

CACHE_ROOT="${ECHO_CI_CACHE_DIR:-$HOME/.cache/echo-ci}"
CACHE_DIR="$CACHE_ROOT/spacy"
SPACY_CACHE="$HOME/.cache/spacy"

echo "🔍 Checking for Spacy cache..."

# Create cache directory if it doesn't exist
mkdir -p "$CACHE_DIR"

# Check if cache exists
if [ -d "$CACHE_DIR" ] && [ "$(ls -A $CACHE_DIR 2>/dev/null)" ]; then
    echo "✅ Restoring Spacy models from local cache"
    mkdir -p "$SPACY_CACHE"
    rsync -a --delete "$CACHE_DIR/" "$SPACY_CACHE/"
    echo "📦 Cache restored successfully"
    exit 0
else
    echo "ℹ️  No Spacy cache found"
fi

echo "🚫 No valid cache available"
exit 1
