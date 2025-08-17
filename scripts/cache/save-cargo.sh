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
MAX_GIT_SIZE=100

echo "💾 Saving Rust cache (selective)..."

# Function to get directory size in MB
get_size_mb() {
    if [ -d "$1" ]; then
        du -sm "$1" 2>/dev/null | cut -f1 || echo "0"
    else
        echo "0"
    fi
}

# Function to clean directory by size
clean_by_size() {
    local dir="$1"
    local max_size="$2"
    local current_size=$(get_size_mb "$dir")

    if [ "$current_size" -gt "$max_size" ]; then
        echo "⚠️  Directory $dir is ${current_size}MB, cleaning to under ${max_size}MB..."
        # Remove oldest files first
        find "$dir" -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | head -n $(( current_size - max_size )) | cut -d' ' -f2- | xargs rm -f 2>/dev/null || true
    fi
}

# Create cache directories
mkdir -p "$CACHE_DIR/registry-index"
mkdir -p "$CACHE_DIR/target"
mkdir -p "$CACHE_DIR/git"

# Save registry index only (not the full cache)
if [ -d "$CARGO_HOME/registry/index" ]; then
    echo "📦 Saving Cargo registry index..."
    rsync -a --delete "$CARGO_HOME/registry/index/" "$CACHE_DIR/registry-index/" 2>/dev/null || \
    cp -r "$CARGO_HOME/registry/index"/* "$CACHE_DIR/registry-index/" 2>/dev/null || true
    echo "✅ Registry index saved"
else
    echo "ℹ️  No registry index found to cache"
fi

# Save git dependencies (but clean if too large)
if [ -d "$CARGO_HOME/git" ]; then
    echo "📦 Saving Cargo git dependencies..."

    # Clean old git repos
    find "$CARGO_HOME/git" -name ".git" -type d -exec dirname {} \; | while read repo; do
        if [ -d "$repo/.git" ]; then
            cd "$repo"
            # Clean up git repo
            git gc --aggressive --prune=now 2>/dev/null || true
            # Remove old refs
            find .git/refs -type f -mtime +30 -delete 2>/dev/null || true
        fi
    done

    rsync -a --delete "$CARGO_HOME/git/" "$CACHE_DIR/git/" 2>/dev/null || \
    cp -r "$CARGO_HOME/git"/* "$CACHE_DIR/git/" 2>/dev/null || true

    # Clean if too large
    clean_by_size "$CACHE_DIR/git" "$MAX_GIT_SIZE"
    echo "✅ Git dependencies saved"
else
    echo "ℹ️  No git dependencies found to cache"
fi

# Save build cache (selective - only what's useful)
if [ -d "$TARGET_DIR" ]; then
    echo "📦 Saving Cargo build cache (selective)..."

    # Only save release builds and dependency artifacts
    if [ -d "$TARGET_DIR/release" ]; then
        # Save release dependencies (these are expensive to rebuild)
        if [ -d "$TARGET_DIR/release/deps" ]; then
            mkdir -p "$CACHE_DIR/target/release"
            cp -r "$TARGET_DIR/release/deps" "$CACHE_DIR/target/release/" 2>/dev/null || true
        fi

        # Save build scripts output
        if [ -d "$TARGET_DIR/release/build" ]; then
            mkdir -p "$CACHE_DIR/target/release"
            cp -r "$TARGET_DIR/release/build" "$CACHE_DIR/target/release/" 2>/dev/null || true
        fi

        # Skip large binary files, incremental data, and workspace artifacts
        # Only keep .rlib, .rmeta, and build script outputs
        find "$CACHE_DIR/target" -type f \( -name "*.exe" -o -name "*.so" -o -name "*.dylib" -o -name "*.dll" \) -size +10M -delete 2>/dev/null || true
    fi

    # Save the Cargo.lock for cache validation
    cp "$CARGO_LOCK" "$CACHE_DIR/" 2>/dev/null || true

    # Clean if too large
    clean_by_size "$CACHE_DIR/target" "$MAX_TARGET_SIZE"
    echo "✅ Build cache saved (release dependencies only)"
else
    echo "⚠️  No target directory found, skipping build cache save"
fi

# Clean up any oversized files in cache
echo "🧹 Cleaning oversized cache files..."
find "$CACHE_DIR" -type f -size +50M -delete 2>/dev/null || true

# Show final cache sizes
echo "📊 Final cache sizes:"
echo "   Registry index: $(get_size_mb "$CACHE_DIR/registry-index")MB"
echo "   Target cache: $(get_size_mb "$CACHE_DIR/target")MB"
echo "   Git cache: $(get_size_mb "$CACHE_DIR/git")MB"

total_size=$(get_size_mb "$CACHE_DIR")
echo "   Total: ${total_size}MB"

if [ "$total_size" -gt 800 ]; then
    echo "⚠️  Total cache size is large (${total_size}MB), consider running clear-cargo.sh"
fi

echo "✅ Rust cache save completed (optimized for size)"
