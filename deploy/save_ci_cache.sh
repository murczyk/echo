#!/usr/bin/env bash
set -euo pipefail

echo "Saving CI caches..."

CACHE_BASE="/tmp/echo-ci-cache"

# Save Python cache
if [ "${1:-}" = "clean" ]; then
    PYTHON_KEY="python-deps-clean-$(date +%s)"
    echo "🧹 Saving Python cache with clean key"
else
    PYTHON_KEY="python-deps-$(sha256sum wdintel-rs/wdintel-py/requirements.txt | cut -d' ' -f1)"
    echo "💾 Saving Python cache"
fi

if [ -d "wdintel-rs/wdintel-py/.venv" ]; then
    echo "✅ Saving Python venv to local cache"
    rm -rf "$CACHE_BASE/python/$PYTHON_KEY"
    mkdir -p "$CACHE_BASE/python"
    cp -r wdintel-rs/wdintel-py/.venv "$CACHE_BASE/python/$PYTHON_KEY"
fi

# Save Rust cache
RUST_KEY="rust-deps-$(sha256sum wdintel-rs/Cargo.lock | cut -d' ' -f1)"
if [ -d "wdintel-rs/target" ] || [ -d "$HOME/.cargo" ]; then
    echo "✅ Saving Rust dependencies to local cache"
    rm -rf "$CACHE_BASE/rust/$RUST_KEY"
    mkdir -p "$CACHE_BASE/rust/$RUST_KEY"/{cargo,target}
    [ -d "$HOME/.cargo" ] && cp -r "$HOME/.cargo"/* "$CACHE_BASE/rust/$RUST_KEY/cargo/" 2>/dev/null || true
    [ -d "wdintel-rs/target" ] && cp -r wdintel-rs/target/* "$CACHE_BASE/rust/$RUST_KEY/target/" 2>/dev/null || true
fi

# Save spacy cache
if [ -d "$HOME/.cache/spacy" ]; then
    echo "✅ Saving spacy models to local cache"
    rm -rf "$CACHE_BASE/spacy/models"
    mkdir -p "$CACHE_BASE/spacy"
    cp -r "$HOME/.cache/spacy" "$CACHE_BASE/spacy/models" 2>/dev/null || true
fi

# Save frontend cache (npm)
NPM_KEY="npm-deps-$(sha256sum wdintel-web/package-lock.json | cut -d' ' -f1)"
if [ -d "wdintel-web/node_modules" ]; then
    echo "✅ Saving npm dependencies to local cache"
    rm -rf "$CACHE_BASE/npm/$NPM_KEY"
    mkdir -p "$CACHE_BASE/npm"
    cp -r wdintel-web/node_modules "$CACHE_BASE/npm/$NPM_KEY"
fi

echo "Cache saving completed!"
