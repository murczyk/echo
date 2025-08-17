#!/bin/bash
set -e

CACHE_DIR="/tmp/cache/spacy"
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

# Create cache directory
mkdir -p "$CACHE_DIR"

# Save Spacy cache
echo "📦 Copying Spacy models to cache..."
cp -r "$SPACY_CACHE"/* "$CACHE_DIR/" 2>/dev/null || true

echo "✅ Spacy cache saved successfully"
echo "📊 Cache size: $(du -sh "$CACHE_DIR" | cut -f1)"
