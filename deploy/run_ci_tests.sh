#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Running backend test suite..."
bash "$SCRIPT_DIR/run_backend_tests.sh"

echo "Running frontend tests..."
cd "$REPO_ROOT/wdintel-web"

lockfile_hash="$(sha256sum package-lock.json | awk '{print $1}')"
installed_hash=""
if [[ -f "node_modules/.npm_installed" ]]; then
    installed_hash="$(tr -d '[:space:]' < node_modules/.npm_installed)"
fi

if [[ ! -d "node_modules" ]] || [[ "$installed_hash" != "$lockfile_hash" ]]; then
    bash "$REPO_ROOT/deploy/ci/require_github_packages_token.sh"
    npm ci
    printf '%s\n' "$lockfile_hash" > node_modules/.npm_installed
fi

npm run test:ci

echo "Frontend tests completed successfully!"
