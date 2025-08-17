#!/bin/bash
set -e

CACHE_DIR="/tmp/cache/cargo"
CARGO_HOME="$HOME/.cargo"

echo "🦀 Clearing Rust/Cargo caches..."

# Function to get directory size in MB
get_size_mb() {
    if [ -d "$1" ]; then
        du -sm "$1" 2>/dev/null | cut -f1 || echo "0"
    else
        echo "0"
    fi
}

# Show current sizes before cleanup
echo "📊 Current cache sizes before cleanup:"
if [ -d "$CACHE_DIR" ]; then
    echo "   Local cache: $(get_size_mb "$CACHE_DIR")MB"
fi
if [ -d "$CARGO_HOME/registry" ]; then
    echo "   Cargo registry: $(get_size_mb "$CARGO_HOME/registry")MB"
fi
if [ -d "$CARGO_HOME/git" ]; then
    echo "   Cargo git: $(get_size_mb "$CARGO_HOME/git")MB"
fi

# Clear local cache
if [ -d "$CACHE_DIR" ]; then
    echo "🗑️  Clearing local Cargo cache..."
    rm -rf "$CACHE_DIR"/*
    echo "✅ Local cache cleared"
else
    echo "ℹ️  No local Cargo cache found"
fi

# Clean Cargo registry cache
if [ -d "$CARGO_HOME/registry" ]; then
    echo "🗑️  Cleaning Cargo registry cache..."

    # Keep index but clear cache and src
    if [ -d "$CARGO_HOME/registry/cache" ]; then
        rm -rf "$CARGO_HOME/registry/cache"/*
        echo "   Registry cache cleared"
    fi

    if [ -d "$CARGO_HOME/registry/src" ]; then
        rm -rf "$CARGO_HOME/registry/src"/*
        echo "   Registry src cleared"
    fi
else
    echo "ℹ️  No Cargo registry cache found"
fi

# Clean Cargo git cache
if [ -d "$CARGO_HOME/git" ]; then
    echo "🗑️  Cleaning Cargo git cache..."

    # Remove old checkouts but keep bare repos
    find "$CARGO_HOME/git" -name "checkouts" -type d -exec rm -rf {} + 2>/dev/null || true

    # Clean git repos
    find "$CARGO_HOME/git" -name ".git" -type d | while read git_dir; do
        repo_dir=$(dirname "$git_dir")
        if [ -d "$repo_dir/.git" ]; then
            echo "   Cleaning git repo: $(basename "$repo_dir")"
            cd "$repo_dir"
            git gc --aggressive --prune=all 2>/dev/null || true
            git remote prune origin 2>/dev/null || true
        fi
    done

    echo "✅ Git cache cleaned"
else
    echo "ℹ️  No Cargo git cache found"
fi

# Use cargo-cache if available
if command -v cargo-cache &> /dev/null; then
    echo "🧹 Running cargo-cache cleanup..."
    cargo-cache --autoclean || true
    cargo-cache --remove-older-than 7d || true
    echo "✅ cargo-cache cleanup completed"
else
    echo "💡 Install cargo-cache for more thorough cleanup: cargo install cargo-cache"
fi

# Clean any target directories in the project
if [ -d "wdintel-rs/target" ]; then
    echo "🗑️  Cleaning project target directory..."
    cd wdintel-rs
    cargo clean || true
    echo "✅ Project target cleaned"
fi

# Show final sizes
echo ""
echo "📊 Cache sizes after cleanup:"
if [ -d "$CACHE_DIR" ]; then
    echo "   Local cache: $(get_size_mb "$CACHE_DIR")MB"
fi
if [ -d "$CARGO_HOME/registry" ]; then
    echo "   Cargo registry: $(get_size_mb "$CARGO_HOME/registry")MB"
fi
if [ -d "$CARGO_HOME/git" ]; then
    echo "   Cargo git: $(get_size_mb "$CARGO_HOME/git")MB"
fi

echo ""
echo "✅ Rust/Cargo cache cleanup completed!"
echo "💡 Next build will download fresh dependencies but should be much faster than network cache restore"
