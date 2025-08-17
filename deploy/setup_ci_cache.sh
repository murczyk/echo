#!/usr/bin/env bash
set -euo pipefail

echo "Setting up CI caches..."

CACHE_BASE="/tmp/echo-ci-cache"
mkdir -p "$CACHE_BASE"/{python,rust,spacy}

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
    cp -r "$CACHE_BASE/python/$PYTHON_KEY" wdintel-rs/wdintel-py/.venv
else
    echo "📥 Python virtual environment will be created fresh"
fi

# Rust cache
RUST_KEY="rust-deps-$(sha256sum wdintel-rs/Cargo.lock | cut -d' ' -f1)"
if [ -d "$CACHE_BASE/rust/$RUST_KEY" ]; then
    echo "✅ Restoring Rust dependencies from local cache"
    mkdir -p ~/.cargo wdintel-rs/target
    [ -d "$CACHE_BASE/rust/$RUST_KEY/cargo" ] && cp -r "$CACHE_BASE/rust/$RUST_KEY/cargo"/* ~/.cargo/ 2>/dev/null || true
    [ -d "$CACHE_BASE/rust/$RUST_KEY/target" ] && cp -r "$CACHE_BASE/rust/$RUST_KEY/target"/* wdintel-rs/target/ 2>/dev/null || true
else
    echo "📥 Rust dependencies will be compiled fresh"
fi

# Spacy cache
if [ -d "$CACHE_BASE/spacy/models" ]; then
    echo "✅ Restoring spacy models from local cache"
    mkdir -p ~/.cache/spacy
    cp -r "$CACHE_BASE/spacy/models"/* ~/.cache/spacy/ 2>/dev/null || true
else
    echo "📥 Spacy models will be downloaded fresh"
fi

# Frontend cache (npm)
NPM_KEY="npm-deps-$(sha256sum wdintel-web/package-lock.json | cut -d' ' -f1)"
if [ -d "$CACHE_BASE/npm/$NPM_KEY" ]; then
    echo "✅ Restoring npm dependencies from local cache"
    cp -r "$CACHE_BASE/npm/$NPM_KEY" wdintel-web/node_modules
else
    echo "📥 npm dependencies will be installed fresh"
fi

echo "Cache setup completed!"
