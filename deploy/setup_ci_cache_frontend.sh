#!/usr/bin/env bash
set -euo pipefail

echo "Setting up frontend CI cache..."

CACHE_BASE="/tmp/echo-ci-cache"
mkdir -p "$CACHE_BASE/npm"

# Frontend cache (npm)
NPM_KEY="npm-deps-$(sha256sum wdintel-web/package-lock.json | cut -d' ' -f1)"
if [ -d "$CACHE_BASE/npm/$NPM_KEY" ]; then
    echo "✅ Restoring npm dependencies from local cache"
    cp -r "$CACHE_BASE/npm/$NPM_KEY" wdintel-web/node_modules
else
    echo "📥 npm dependencies will be installed fresh"
fi

echo "Frontend cache setup completed!"
