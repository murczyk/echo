#!/usr/bin/env bash
set -euo pipefail

echo "Setting up CI caches (optimized)..."

CACHE_BASE="/tmp/echo-ci-cache"
mkdir -p "$CACHE_BASE"/{python,rust,spacy,npm}

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

# Optimized Rust cache
RUST_KEY="rust-deps-$(sha256sum wdintel-rs/Cargo.lock | cut -d' ' -f1)"
if [ -d "$CACHE_BASE/rust/$RUST_KEY" ]; then
    echo "✅ Restoring Rust dependencies from local cache (optimized)"

    # Create target directories
    mkdir -p ~/.cargo wdintel-rs/target

    # Restore cargo registry and git caches (parallel)
    {
        if [ -d "$CACHE_BASE/rust/$RUST_KEY/cargo-registry" ]; then
            mkdir -p ~/.cargo/registry
            rsync -a "$CACHE_BASE/rust/$RUST_KEY/cargo-registry/" ~/.cargo/registry/
        fi
    } &

    {
        if [ -d "$CACHE_BASE/rust/$RUST_KEY/cargo-git" ]; then
            mkdir -p ~/.cargo/git
            rsync -a "$CACHE_BASE/rust/$RUST_KEY/cargo-git/" ~/.cargo/git/
        fi
    } &

    {
        if [ -d "$CACHE_BASE/rust/$RUST_KEY/target-deps" ]; then
            mkdir -p wdintel-rs/target/release/deps wdintel-rs/target/debug/deps
            rsync -a "$CACHE_BASE/rust/$RUST_KEY/target-deps/" wdintel-rs/target/
        fi
    } &

    # Wait for all parallel operations to complete
    wait

else
    echo "📥 Rust dependencies will be compiled fresh"
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

echo "Cache setup completed!"
