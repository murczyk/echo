#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <server> [remote-deb-path]" >&2
  exit 1
fi

server="$1"
package_path="${2:-packages}"
if [[ "$package_path" != packages && ! "$package_path" =~ ^/var/tmp/[a-zA-Z0-9_.+~:-]+\.deb$ ]]; then
  echo "Expected a package under /var/tmp." >&2
  exit 1
fi
ssh "$server" bash -s -- "$package_path" <<'REMOTE'
set -euo pipefail
package_path="$1"
packages=(echo-install wdintel-rs)
options=()
if [[ "$package_path" != packages ]]; then
  [[ "$package_path" == /var/tmp/*.deb ]] || exit 1
  [[ -r "$package_path" ]] || exit 1
  packages=("$package_path")
  options=(--reinstall --allow-downgrades)
fi
download_packages() {
  echo "Downloading packages and dependencies before stopping Echo..."
  timeout --foreground 1200s sudo env DEBIAN_FRONTEND=noninteractive \
    apt-get -o Dpkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confnew \
    --download-only -y -qq install "${options[@]}" "${packages[@]}"
}
if [[ "$package_path" != packages ]] && download_packages; then
  exit 0
fi
echo "Refreshing package metadata while Echo is still available..."
timeout --foreground 600s sudo apt-get -o Dpkg::Lock::Timeout=120 -qq update
download_packages
REMOTE
