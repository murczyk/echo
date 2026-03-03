#!/usr/bin/env bash
set -euo pipefail

NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-enabled/goi}"

if [[ ! -f "$NGINX_SITE" ]]; then
  echo "nginx site config not found: $NGINX_SITE" >&2
  exit 1
fi

ssl_crt="$(
  awk '
    $1=="ssl_certificate" {
      gsub(/;/, "", $2);
      print $2;
      exit;
    }
  ' "$NGINX_SITE"
)"

ssl_key="$(
  awk '
    $1=="ssl_certificate_key" {
      gsub(/;/, "", $2);
      print $2;
      exit;
    }
  ' "$NGINX_SITE"
)"

if [[ -z "$ssl_crt" || -z "$ssl_key" ]]; then
  echo "ssl_certificate or ssl_certificate_key not found in $NGINX_SITE" >&2
  exit 1
fi

crt_dir="$(dirname "$ssl_crt")"
key_dir="$(dirname "$ssl_key")"
crt_base="$(basename "$ssl_crt")"
key_base="$(basename "$ssl_key")"

if [[ "$crt_dir" != "$key_dir" ]]; then
  echo "certificate and key must be in the same directory: $ssl_crt $ssl_key" >&2
  exit 1
fi

if [[ "$crt_base" != *.crt ]]; then
  echo "certificate path must end with .crt: $ssl_crt" >&2
  exit 1
fi

cert_name="${crt_base%.crt}"
if [[ "$key_base" != "${cert_name}.key" ]]; then
  echo "certificate/key base names must match: $crt_base $key_base" >&2
  exit 1
fi

if [[ "$crt_dir" != /etc/* ]]; then
  echo "certificate path must be under /etc: $ssl_crt" >&2
  exit 1
fi

app_name="$(basename "$crt_dir")"

echo "renewing tailscale cert app_name=${app_name} cert_name=${cert_name} from ${NGINX_SITE}"

exec echo-install-utils renew-cert \
  --interactive=false \
  --app-name "$app_name" \
  --cert-name "$cert_name" \
  --reload nginx.service
