#!/usr/bin/env bash
set -euo pipefail

echo "🧹 Cleaning Python and Node.js dependencies..."

# Function to safely remove directory if it exists
safe_remove() {
    if [ -d "$1" ]; then
        echo "Removing $1..."
        rm -rf "$1"
    else
        echo "$1 doesn't exist, skipping"
    fi
}

# Function to safely remove file if it exists
safe_remove_file() {
    if [ -f "$1" ]; then
        echo "Removing $1..."
        rm -f "$1"
    else
        echo "$1 doesn't exist, skipping"
    fi
}

# Clean Python virtual environment
echo "🐍 Cleaning Python virtual environment..."
safe_remove "wdintel-rs/wdintel-py/.venv"
safe_remove_file "wdintel-rs/wdintel-py/.requirements_installed"

# Clean npm dependencies
echo "📦 Cleaning npm dependencies..."
safe_remove "wdintel-web/node_modules"
safe_remove_file "wdintel-web/node_modules/.npm_installed"

# Clean spacy cache
echo "🧠 Cleaning spacy model cache..."
safe_remove "$HOME/.cache/spacy"

# Clean npm cache
echo "🗄️  Cleaning npm cache..."
if command -v npm >/dev/null 2>&1; then
    npm cache clean --force 2>/dev/null || echo "npm cache clean failed or not needed"
fi

# Clean pip cache
echo "🐍 Cleaning pip cache..."
if command -v pip >/dev/null 2>&1; then
    pip cache purge 2>/dev/null || echo "pip cache purge failed or not needed"
fi

# Clean cargo cache
echo "🦀 Cleaning cargo build cache..."
safe_remove "wdintel-rs/target"

# Clean cargo registry cache
echo "🦀 Cleaning cargo registry cache..."
safe_remove "$HOME/.cargo/registry/cache"
safe_remove "$HOME/.cargo/registry/index"
safe_remove "$HOME/.cargo/git/db"

# Clean cargo incremental cache
echo "🦀 Cleaning cargo incremental cache..."
safe_remove "$HOME/.cargo/.package-cache"

# Clean local CI cache
echo "🗂️  Cleaning local CI cache..."
safe_remove "/tmp/echo-ci-cache"

echo "✅ Cleanup complete!"
echo ""
echo "Next steps:"
echo "  - Run 'just dev-py' to recreate Python environment"
echo "  - Run 'just test-fe' to reinstall npm dependencies"
echo "  - Run 'just test-be' to recompile Rust dependencies"
echo "  - Or simply run 'just test' to rebuild everything"
echo "  - Local CI cache cleared - next CI run will rebuild caches"
