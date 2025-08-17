#!/bin/bash
set -e

CACHE_DIR="/tmp/cache/cargo"
PROJECT_DIR="wdintel-rs"
CARGO_LOCK="$PROJECT_DIR/Cargo.lock"
TARGET_DIR="$PROJECT_DIR/target"
CARGO_HOME="$HOME/.cargo"

# Cache size limits (in MB)
MAX_REGISTRY_SIZE=200
MAX_TARGET_SIZE=500
MAX_TOTAL_SIZE=1000

echo "🦀 Checking for Rust cache..."

# Function to get directory size in MB
get_size_mb() {
    if [ -d "$1" ]; then
        du -sm "$1" 2>/dev/null | cut -f1 || echo "0"
    else
        echo "0"
    fi
}

# Function to clean old cargo cache
clean_cargo_cache() {
    echo "🧹 Cleaning Cargo cache..."

    # Install cargo-cache if not available
    if ! command -v cargo-cache &> /dev/null; then
        echo "📦 Installing cargo-cache..."
        cargo install cargo-cache || true
    fi

    # Clean old registry files
    if command -v cargo-cache &> /dev/null; then
        cargo-cache --autoclean-expensive || true
        cargo-cache --remove-older-than 30d || true
    fi

    # Manual cleanup of registry cache if too large
    if [ -d "$CARGO_HOME/registry" ]; then
        registry_size=$(get_size_mb "$CARGO_HOME/registry")
        if [ "$registry_size" -gt "$MAX_REGISTRY_SIZE" ]; then
            echo "⚠️  Registry cache too large (${registry_size}MB), cleaning oldest entries..."
            # Remove old extracted sources
            find "$CARGO_HOME/registry/src" -type d -mtime +30 -exec rm -rf {} + 2>/dev/null || true
            # Keep only recent cache entries
            find "$CARGO_HOME/registry/cache" -name "*.crate" -mtime +30 -delete 2>/dev/null || true
        fi
    fi
}

# Create cache directories
mkdir -p "$CACHE_DIR/registry-index"
mkdir -p "$CACHE_DIR/target"
mkdir -p "$CACHE_DIR/git"

# Restore registry index (small but important)
if [ -d "$CACHE_DIR/registry-index" ] && [ "$(ls -A $CACHE_DIR/registry-index 2>/dev/null)" ]; then
    echo "✅ Restoring Cargo registry index from local cache"
    mkdir -p "$CARGO_HOME/registry"
    rsync -a "$CACHE_DIR/registry-index/" "$CARGO_HOME/registry/" 2>/dev/null || \
    cp -r "$CACHE_DIR/registry-index"/* "$CARGO_HOME/registry/" 2>/dev/null || true
    echo "📦 Registry index restored"
else
    echo "ℹ️  No Cargo registry index cache found"
fi

# Restore git dependencies
if [ -d "$CACHE_DIR/git" ] && [ "$(ls -A $CACHE_DIR/git 2>/dev/null)" ]; then
    echo "✅ Restoring Cargo git dependencies"
    mkdir -p "$CARGO_HOME/git"
    rsync -a "$CACHE_DIR/git/" "$CARGO_HOME/git/" 2>/dev/null || \
    cp -r "$CACHE_DIR/git"/* "$CARGO_HOME/git/" 2>/dev/null || true
    echo "📦 Git dependencies restored"
else
    echo "ℹ️  No Cargo git cache found"
fi

# Restore build cache (selective)
if [ -d "$CACHE_DIR/target" ] && [ -f "$CACHE_DIR/Cargo.lock" ]; then
    if cmp -s "$CARGO_LOCK" "$CACHE_DIR/Cargo.lock"; then
        echo "✅ Restoring Cargo build cache"

        # Only restore release builds and dependencies, skip debug artifacts
        if [ -d "$CACHE_DIR/target/release" ]; then
            mkdir -p "$TARGET_DIR"
            cp -r "$CACHE_DIR/target/release" "$TARGET_DIR/" 2>/dev/null || true
        fi

        # Restore dependency builds but not workspace builds
        if [ -d "$CACHE_DIR/target/release/deps" ]; then
            mkdir -p "$TARGET_DIR/release"
            cp -r "$CACHE_DIR/target/release/deps" "$TARGET_DIR/release/" 2>/dev/null || true
        fi

        # Restore build cache
        if [ -d "$CACHE_DIR/target/release/build" ]; then
            mkdir -p "$TARGET_DIR/release"
            cp -r "$CACHE_DIR/target/release/build" "$TARGET_DIR/release/" 2>/dev/null || true
        fi

        echo "📦 Build cache restored (release only)"
    else
        echo "⚠️  Cargo.lock changed, build cache invalid"
        rm -rf "$CACHE_DIR/target"/*
    fi
else
    echo "ℹ️  No Cargo build cache found"
fi

# Clean cargo cache if it's getting too large
clean_cargo_cache

# Show cache sizes
echo "📊 Current cache sizes:"
echo "   Registry: $(get_size_mb "$CARGO_HOME/registry")MB"
echo "   Target: $(get_size_mb "$TARGET_DIR")MB"
echo "   Git: $(get_size_mb "$CARGO_HOME/git")MB"

echo "✅ Cargo cache restore completed"
