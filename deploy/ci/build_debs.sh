#!/usr/bin/env bash
set -euxo pipefail

# Build release binaries and produce .deb packages using cargo-deb

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

mkdir -p target/debian
find target/debian -maxdepth 1 -type f -name '*.deb' -delete || true

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
wdintel_epoch=""
if [ -d "wdintel-rs" ]; then
  wdintel_epoch="$(git log -1 --format=%ct -- wdintel-rs 2>/dev/null || true)"
  if [ -z "$wdintel_epoch" ]; then
    wdintel_epoch="$(date -u +%s)"
  fi
fi

if [ -n "$wdintel_epoch" ]; then
  SOURCE_DATE_EPOCH="$wdintel_epoch" cargo build --release \
    -p wdintel-rs \
    -p echo-install
else
  cargo build --release \
    -p wdintel-rs \
    -p echo-install
fi

# Build deb packages for workspace members
if [ -n "$wdintel_epoch" ]; then
  touch -d "@$wdintel_epoch" wdintel-rs/version.txt 2>/dev/null || true
  touch -d "@$wdintel_epoch" target/release/wdintel-rs 2>/dev/null || true
  SOURCE_DATE_EPOCH="$wdintel_epoch" cargo deb -p wdintel-rs --no-build
else
  cargo deb -p wdintel-rs --no-build
fi
cargo deb -p echo-install --no-build || true

# Build deb packages for non-workspace crates and copy them to root target/debian
doc_version_epoch=""
if [ -f "docs/echo-docs/Cargo.toml" ]; then
  doc_version_epoch="$(git log -1 --format=%ct -- docs/echo-docs/Cargo.toml 2>/dev/null || true)"
  if [ -z "$doc_version_epoch" ]; then
    doc_version_epoch="$(date -u +%s)"
  fi
fi

# echo-docs
if [ -f "docs/echo-docs/Cargo.toml" ]; then
  # Ensure Zola site is built so that docs/public/* exists for packaging
  if [ ! -d "docs/public" ] || [ -z "$(ls -A docs/public 2>/dev/null || true)" ]; then
    echo "> Building docs site (zola)"
    if ! command -v zola >/dev/null 2>&1; then
      echo "Zola not found, installing via cargo..."
      cargo install zola --locked
    fi
    (cd docs && zola build)
  fi

  if [ -n "$doc_version_epoch" ]; then
    find docs/public -exec touch -d "@$doc_version_epoch" {} +
  fi

  if [ -d "docs/echo-docs/target/debian" ]; then
    find docs/echo-docs/target/debian -maxdepth 1 -type f -name '*.deb' -delete || true
  fi

  if [ -n "$doc_version_epoch" ]; then
    (cd docs/echo-docs && SOURCE_DATE_EPOCH="$doc_version_epoch" cargo deb)
  else
    (cd docs/echo-docs && cargo deb)
  fi
  cp -v docs/echo-docs/target/debian/*.deb target/debian/ || true
fi

# Also copy workspace-built debs (cargo-deb already places them under root target/debian)
ls -lah target/debian || true
echo "DEBs built under target/debian/"
