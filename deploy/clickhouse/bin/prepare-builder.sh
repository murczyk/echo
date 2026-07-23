#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_versions

TOOLCHAIN_ROOT=${ECHO_CLICKHOUSE_TOOLCHAIN_ROOT:-$HOME/.local/share/echo-clickhouse-toolchains}
BIN_DIR=$TOOLCHAIN_ROOT/bin

[[ $(uname -m) == x86_64 ]] || die "only x86_64 builders are currently supported"
. /etc/os-release
case "$ID" in
  debian|ubuntu)
    ;;
  *)
    die "builder must be Debian or Ubuntu; found $ID"
    ;;
esac

log "Installing builder bootstrap dependencies"
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates \
  curl \
  gnupg

require_cmd curl
require_cmd gpg
require_cmd sha256sum
require_cmd tar

mkdir -p "$TOOLCHAIN_ROOT" "$BIN_DIR"
tmp_dir=$(mktemp -d "$TOOLCHAIN_ROOT/.prepare.XXXXXX")
trap 'rm -rf -- "$tmp_dir"' EXIT

log "Installing the PostgreSQL PGDG repository on the builder"
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$tmp_dir/pgdg.asc"
printf '%s  %s\n' "$PGDG_APT_KEY_SHA256" "$tmp_dir/pgdg.asc" | sha256sum --check
sudo install -d -m 0755 /etc/apt/keyrings
gpg --dearmor <"$tmp_dir/pgdg.asc" >"$tmp_dir/pgdg.gpg"
sudo install -m 0644 "$tmp_dir/pgdg.gpg" /etc/apt/keyrings/postgresql.gpg
printf 'deb [signed-by=/etc/apt/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' \
  "$VERSION_CODENAME" | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null

log "Installing native build dependencies on the builder"
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  build-essential \
  ca-certificates \
  cmake \
  curl \
  git \
  libcurl4-openssl-dev \
  libgeos-dev \
  liblz4-dev \
  libssl-dev \
  libzstd-dev \
  pkg-config \
  "postgresql-server-dev-$POSTGRESQL_MAJOR" \
  rsync \
  tar \
  uuid-dev

go_archive="go${GO_VERSION}.linux-amd64.tar.gz"
log "Installing Go $GO_VERSION"
curl -fsSL "https://go.dev/dl/$go_archive" -o "$tmp_dir/$go_archive"
printf '%s  %s\n' "$GO_LINUX_AMD64_SHA256" "$tmp_dir/$go_archive" | sha256sum --check
if [[ ! -x "$TOOLCHAIN_ROOT/go-$GO_VERSION/bin/go" ]]; then
  mkdir -p "$TOOLCHAIN_ROOT/go-$GO_VERSION"
  tar -xzf "$tmp_dir/$go_archive" -C "$TOOLCHAIN_ROOT/go-$GO_VERSION" --strip-components=1
fi

log "Installing buf $BUF_VERSION"
curl -fsSL \
  "https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-Linux-x86_64" \
  -o "$tmp_dir/buf"
printf '%s  %s\n' "$BUF_LINUX_AMD64_SHA256" "$tmp_dir/buf" | sha256sum --check
install -m 0755 "$tmp_dir/buf" "$BIN_DIR/buf"

rustup_url="https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init"
log "Installing Rust $RUST_VERSION through pinned rustup $RUSTUP_VERSION"
curl -fsSL "$rustup_url" -o "$tmp_dir/rustup-init"
printf '%s  %s\n' "$RUSTUP_INIT_LINUX_AMD64_SHA256" "$tmp_dir/rustup-init" | sha256sum --check
chmod 0755 "$tmp_dir/rustup-init"
RUSTUP_HOME="$TOOLCHAIN_ROOT/rustup" \
CARGO_HOME="$TOOLCHAIN_ROOT/cargo" \
  "$tmp_dir/rustup-init" -y --profile minimal --default-toolchain "$RUST_VERSION"

cat <<EOF
Builder prepared. Export these values before building:
  export ECHO_CLICKHOUSE_TOOLCHAIN_ROOT='$TOOLCHAIN_ROOT'
  export PATH='$TOOLCHAIN_ROOT/go-$GO_VERSION/bin:$TOOLCHAIN_ROOT/cargo/bin:$BIN_DIR:\$PATH'
  export RUSTUP_HOME='$TOOLCHAIN_ROOT/rustup'
  export CARGO_HOME='$TOOLCHAIN_ROOT/cargo'
EOF
