#!/usr/bin/env bash
set -euo pipefail

echo "Saving frontend CI cache..."

CACHE_BASE="/tmp/echo-ci-cache"

# Save frontend cache (npm)
NPM_KEY="npm-deps-$(sha256sum wdintel-web/package-lock.json | cut -d' ' -f1)"
if [ -d "wdintel-web/node_modules" ]; then
    echo "✅ Saving npm dependencies to local cache"
    rm -rf "$CACHE_BASE/npm/$NPM_KEY"
    mkdir -p "$CACHE_BASE/npm"
    cp -r wdintel-web/node_modules "$CACHE_BASE/npm/$NPM_KEY"
fi

echo "Frontend cache saving completed!"
