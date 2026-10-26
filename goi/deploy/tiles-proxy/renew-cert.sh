#!/usr/bin/env bash
set -euo pipefail

cert_dir=/etc/goi-tiles-proxy
domain=goi-tiles-proxy.chimp-tiaki.ts.net
temp_dir="$(mktemp -d "${cert_dir}/.renew.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

cp -p "${cert_dir}/tailscale.crt" "${temp_dir}/old.crt"
cp -p "${cert_dir}/tailscale.key" "${temp_dir}/old.key"
tailscale cert \
  --cert-file "${temp_dir}/new.crt" \
  --key-file "${temp_dir}/new.key" \
  "$domain"

install -m 0644 "${temp_dir}/new.crt" "${cert_dir}/tailscale.crt"
install -m 0600 "${temp_dir}/new.key" "${cert_dir}/tailscale.key"
if ! nginx -t || ! systemctl reload nginx; then
  install -m 0644 "${temp_dir}/old.crt" "${cert_dir}/tailscale.crt"
  install -m 0600 "${temp_dir}/old.key" "${cert_dir}/tailscale.key"
  nginx -t
  systemctl reload nginx
  exit 1
fi
