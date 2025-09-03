#!/usr/bin/env bash
set -euxo pipefail

# Build release binaries and produce .deb packages using cargo-deb

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# Ensure cargo-deb is available
if ! command -v cargo-deb >/dev/null 2>&1; then
  cargo install cargo-deb --locked
fi

# Build frontend assets required by wdintel-rs package
if [ -d "wdintel-web" ]; then
  echo "> Building frontend (wdintel-web)"
  (cd wdintel-web && npm ci && npm run build)
fi

# Build release binaries first for faster cargo-deb (reuse artifacts)
cargo build --release \
  -p wdintel-rs \
  -p echo-install

# Build deb packages for workspace members
cargo deb -p wdintel-rs --no-build
cargo deb -p echo-install --no-build || true

# Build deb packages for non-workspace crates and copy them to root target/debian
mkdir -p target/debian

# echo-docs
if [ -f "docs/echo-docs/Cargo.toml" ]; then
  (cd docs/echo-docs && cargo deb)
  cp -v docs/echo-docs/target/debian/*.deb target/debian/ || true
fi

# Also copy workspace-built debs (cargo-deb already places them under root target/debian)
ls -lah target/debian || true
echo "DEBs built under target/debian/"
