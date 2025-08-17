#!/usr/bin/env bash
set -euo pipefail

echo "Saving CI caches (with sccache)..."

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

# Save sccache cache
if [ -n "${SCCACHE_DIR:-}" ] && [ -d "$SCCACHE_DIR" ]; then
    echo "✅ Saving sccache cache"
    # sccache manages its own cache format, just ensure permissions are correct
    chmod -R 755 "$SCCACHE_DIR" 2>/dev/null || true

    # Print final sccache statistics
    echo "📊 Final sccache statistics:"
    sccache --show-stats || echo "  (sccache stats not available)"
else
    echo "⚠️  sccache cache directory not found or not set"
fi

# Save minimal cargo cache (only registry index and cache, not compiled artifacts)
CARGO_KEY="cargo-minimal-$(sha256sum wdintel-rs/Cargo.lock | cut -d' ' -f1)"
if [ -d "$HOME/.cargo" ]; then
    echo "✅ Saving minimal cargo cache"
    mkdir -p "$CACHE_BASE/cargo-minimal"
    rsync -a \
        --include="registry/" \
        --include="registry/index/" \
        --include="registry/index/**" \
        --include="registry/cache/" \
        --include="registry/cache/**" \
        --include="git/" \
        --include="git/db/" \
        --include="git/db/**" \
        --exclude="*" \
        "$HOME/.cargo/" \
        "$CACHE_BASE/cargo-minimal/$CARGO_KEY/"
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

echo "Cache saving completed with sccache!"
