#!/bin/bash
set -e

CACHE_BASE="/tmp/cache"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🧹 Clearing all local caches..."

# List of cache directories
CACHE_DIRS=(
    "$CACHE_BASE/npm"
    "$CACHE_BASE/python"
    "$CACHE_BASE/spacy"
)

# Clear each cache directory (except Cargo, handled separately)
for cache_dir in "${CACHE_DIRS[@]}"; do
    if [ -d "$cache_dir" ]; then
        echo "🗑️  Clearing $(basename "$cache_dir") cache..."
        rm -rf "$cache_dir"/*
        echo "✅ $(basename "$cache_dir") cache cleared"
    else
        echo "ℹ️  No $(basename "$cache_dir") cache found"
    fi
done

# Use specialized Cargo cleanup
echo ""
echo "🦀 Running specialized Cargo cleanup..."
if [ -f "$SCRIPT_DIR/clear-cargo.sh" ]; then
    "$SCRIPT_DIR/clear-cargo.sh"
else
    echo "⚠️  Cargo cleanup script not found, falling back to basic cleanup"
    if [ -d "$CACHE_BASE/cargo" ]; then
        rm -rf "$CACHE_BASE/cargo"/*
        echo "✅ Basic Cargo cache cleared"
    fi
fi

# Show remaining cache sizes
echo ""
echo "📊 Remaining cache sizes:"
for cache_dir in "${CACHE_DIRS[@]}"; do
    if [ -d "$cache_dir" ]; then
        size=$(du -sh "$cache_dir" 2>/dev/null | cut -f1 || echo "0B")
        echo "   $(basename "$cache_dir"): $size"
    fi
done

if [ -d "$CACHE_BASE/cargo" ]; then
    size=$(du -sh "$CACHE_BASE/cargo" 2>/dev/null | cut -f1 || echo "0B")
    echo "   cargo: $size"
fi

echo ""
echo "✅ All caches cleared successfully!"
echo "💡 Next CI run will rebuild caches but should be much faster than network downloads"
