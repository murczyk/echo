#!/usr/bin/env bash
set -euo pipefail

echo "Setting up CI caches (with sccache)..."

CACHE_BASE="/tmp/echo-ci-cache"
mkdir -p "$CACHE_BASE"/{python,sccache,spacy,npm}

# Python cache
if [ "${1:-}" = "clean" ]; then
    PYTHON_KEY="python-deps-clean-$(date +%s)"
    echo "🧹 Python cache cleanup requested"
else
    PYTHON_KEY="python-deps-$(sha256sum wdintel-rs/wdintel-py/requirements.txt | cut -d' ' -f1)"
    echo "♻️ Using existing Python cache if available"
fi

if [ -d "$CACHE_BASE/python/$PYTHON_KEY" ]; then
    echo "✅ Restoring Python venv from local cache"
    mkdir -p wdintel-rs/wdintel-py
    rsync -a --delete "$CACHE_BASE/python/$PYTHON_KEY/" wdintel-rs/wdintel-py/.venv/
else
    echo "📥 Python virtual environment will be created fresh"
fi

# Setup sccache for Rust
echo "🚀 Setting up sccache for Rust compilation"

# Install sccache if not already present
if ! command -v sccache &> /dev/null; then
    echo "📥 Installing sccache..."
    cargo install sccache
fi

# Configure sccache to use local directory cache
export SCCACHE_DIR="$CACHE_BASE/sccache"
export RUSTC_WRAPPER="sccache"
export SCCACHE_CACHE_SIZE="2G"

# Restore sccache cache if it exists
if [ -d "$CACHE_BASE/sccache" ]; then
    echo "✅ Restoring sccache cache"
    # sccache uses its own cache format, no need to copy anything
    # Just ensure the directory exists and is accessible
    chmod -R 755 "$CACHE_BASE/sccache" 2>/dev/null || true
else
    echo "📥 sccache will build fresh cache"
    mkdir -p "$CACHE_BASE/sccache"
fi

# Minimal cargo cache for registry/index (much smaller than full cache)
CARGO_KEY="cargo-minimal-$(sha256sum wdintel-rs/Cargo.lock | cut -d' ' -f1)"
if [ -d "$CACHE_BASE/cargo-minimal/$CARGO_KEY" ]; then
    echo "✅ Restoring minimal cargo cache"
    mkdir -p ~/.cargo
    rsync -a "$CACHE_BASE/cargo-minimal/$CARGO_KEY/" ~/.cargo/
else
    echo "📥 Cargo registry will be downloaded fresh"
fi

# Spacy cache
if [ -d "$CACHE_BASE/spacy/models" ]; then
    echo "✅ Restoring spacy models from local cache"
    mkdir -p ~/.cache/spacy
    rsync -a "$CACHE_BASE/spacy/models/" ~/.cache/spacy/
else
    echo "📥 Spacy models will be downloaded fresh"
fi

# Frontend cache (npm)
NPM_KEY="npm-deps-$(sha256sum wdintel-web/package-lock.json | cut -d' ' -f1)"
if [ -d "$CACHE_BASE/npm/$NPM_KEY" ]; then
    echo "✅ Restoring npm dependencies from local cache"
    mkdir -p wdintel-web
    rsync -a --delete "$CACHE_BASE/npm/$NPM_KEY/" wdintel-web/node_modules/
else
    echo "📥 npm dependencies will be installed fresh"
fi

# Print sccache stats
echo "📊 sccache statistics:"
sccache --show-stats || echo "  (sccache stats not available yet)"

echo "Cache setup completed with sccache!"
echo "🔧 Environment variables set:"
echo "  RUSTC_WRAPPER=$RUSTC_WRAPPER"
echo "  SCCACHE_DIR=$SCCACHE_DIR"
echo "  SCCACHE_CACHE_SIZE=$SCCACHE_CACHE_SIZE"
