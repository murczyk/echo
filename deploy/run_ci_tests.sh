#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Running backend test suite..."
bash "$SCRIPT_DIR/run_backend_tests.sh"

echo "Running frontend TypeScript tests..."
cd "$REPO_ROOT/wdintel-web"

if [[ ! -d "node_modules" ]] || [[ ! -f "node_modules/.npm_installed" ]] || [[ "package-lock.json" -nt "node_modules/.npm_installed" ]]; then
    npm ci
    touch node_modules/.npm_installed
fi

npm run test:ts

echo "Frontend TypeScript tests completed successfully!"
