#!/bin/bash
set -euo pipefail

CACHE_ROOT="${ECHO_CI_CACHE_DIR:-$HOME/.cache/echo-ci}"
CACHE_DIR="$CACHE_ROOT/spacy"
SPACY_CACHE="$HOME/.cache/spacy"

echo "💾 Saving Spacy cache..."

# Check if Spacy cache exists
if [ ! -d "$SPACY_CACHE" ]; then
    echo "ℹ️  No Spacy cache directory found, skipping cache save"
    exit 0
fi

# Check if there's anything to cache
if [ ! "$(ls -A $SPACY_CACHE 2>/dev/null)" ]; then
    echo "ℹ️  Spacy cache is empty, skipping cache save"
    exit 0
fi

mkdir -p "$CACHE_DIR"

# Save Spacy cache using rsync
echo "📦 Syncing Spacy models to cache..."
rsync -a --delete "$SPACY_CACHE/" "$CACHE_DIR/"

echo "✅ Spacy cache saved successfully"
echo "📊 Cache size: $(du -sh "$CACHE_DIR" | cut -f1)"
