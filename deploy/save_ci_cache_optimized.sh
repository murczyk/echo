#!/usr/bin/env bash
set -euo pipefail

echo "Saving CI caches (optimized)..."

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
    mkdir -p "$CACHE_BASE/python"
    rsync -a --delete wdintel-rs/wdintel-py/.venv/ "$CACHE_BASE/python/$PYTHON_KEY/"
fi

# Optimized Rust cache - save only what's needed
RUST_KEY="rust-deps-$(sha256sum wdintel-rs/Cargo.lock | cut -d' ' -f1)"
if [ -d "wdintel-rs/target" ] || [ -d "$HOME/.cargo" ]; then
    echo "✅ Saving Rust dependencies to local cache (optimized)"

    # Create cache directory structure
    mkdir -p "$CACHE_BASE/rust/$RUST_KEY"/{cargo-registry,cargo-git,target-deps}

    # Save cargo caches (parallel operations)
    {
        if [ -d "$HOME/.cargo/registry" ]; then
            echo "  📦 Saving cargo registry cache"
            rsync -a \
                --exclude="*.tmp" \
                --exclude="*.lock" \
                --exclude="tmp*" \
                "$HOME/.cargo/registry/" \
                "$CACHE_BASE/rust/$RUST_KEY/cargo-registry/"
        fi
    } &

    {
        if [ -d "$HOME/.cargo/git" ]; then
            echo "  🔗 Saving cargo git cache"
            rsync -a \
                --exclude="*.tmp" \
                --exclude="*.lock" \
                --exclude="tmp*" \
                "$HOME/.cargo/git/" \
                "$CACHE_BASE/rust/$RUST_KEY/cargo-git/"
        fi
    } &

    {
        if [ -d "wdintel-rs/target" ]; then
            echo "  🎯 Saving target dependencies"
            # Only save compiled dependencies, not incremental compilation artifacts
            rsync -a \
                --include="*/" \
                --include="*/deps/" \
                --include="*/deps/**" \
                --include="*/build/" \
                --include="*/build/**" \
                --exclude="*/incremental/" \
                --exclude="*/fingerprint/" \
                --exclude="*/.fingerprint" \
                --exclude="*/examples/" \
                --exclude="*/tests/" \
                --exclude="*.d" \
                --exclude="*.tmp" \
                --exclude="*.lock" \
                --exclude="tmp*" \
                wdintel-rs/target/ \
                "$CACHE_BASE/rust/$RUST_KEY/target-deps/"
        fi
    } &

    # Wait for all parallel operations to complete
    wait
fi

# Save spacy cache
if [ -d "$HOME/.cache/spacy" ]; then
    echo "✅ Saving spacy models to local cache"
    mkdir -p "$CACHE_BASE/spacy"
    rsync -a "$HOME/.cache/spacy/" "$CACHE_BASE/spacy/models/"
fi

# Save frontend cache (npm)
NPM_KEY="npm-deps-$(sha256sum wdintel-web/package-lock.json | cut -d' ' -f1)"
if [ -d "wdintel-web/node_modules" ]; then
    echo "✅ Saving npm dependencies to local cache"
    mkdir -p "$CACHE_BASE/npm"
    rsync -a --delete wdintel-web/node_modules/ "$CACHE_BASE/npm/$NPM_KEY/"
fi

echo "Cache saving completed!"
