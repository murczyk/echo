#!/usr/bin/env bash
set -euo pipefail

root=${1:-/opt/echo-document-extractor/models}
cache=/var/cache/echo-document-extractor/verified-assets
tool=/usr/lib/echo-document-extractor/echo_document_extractor/model_store.py
[[ -d "$root" && -f "$root/SHA256SUMS" ]] \
  || { printf 'model set is incomplete: %s\n' "$root" >&2; exit 1; }
install -d -m 0755 "$cache"
if [[ -f "$root/manifest.json" ]]; then
  identifier=$(/usr/bin/python3 "$tool" id --manifest "$root/manifest.json")
else
  identifier="legacy-$(sha256sum "$root/SHA256SUMS" | cut -c1-64)"
fi
marker="$cache/models-$identifier"
if [[ ! -f "$marker" ]]; then
  if [[ -f "$root/manifest.json" ]]; then
    /usr/bin/python3 "$tool" verify --manifest "$root/manifest.json" --root "$root"
  else
    (cd "$root" && sha256sum --check --strict SHA256SUMS >/dev/null)
  fi
  install -m 0444 /dev/null "$marker"
fi
printf '%s\n' "$identifier"
