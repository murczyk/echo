#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) == 0 ]] || { printf 'sync-models.sh must run as root\n' >&2; exit 1; }
active=/opt/echo-document-extractor/models
store=/var/lib/echo-document-extractor/model-sets
objects=/var/cache/echo-document-extractor/model-objects
tool=/usr/lib/echo-document-extractor/echo_document_extractor/model_store.py
s5cmd=/opt/echo-document-extractor/bin/s5cmd
endpoint=${ECHO_DOCUMENT_EXTRACTOR_MODELS_ENDPOINT:?model endpoint is required}
prefix=${ECHO_DOCUMENT_EXTRACTOR_MODELS_PREFIX:?model prefix is required}
prefix=${prefix%/}
install -d -m 0755 "$store" "$objects"

legacy=0
if [[ -d "$active" && ! -L "$active" && -f "$active/SHA256SUMS" ]]; then
  legacy=1
fi
temporary=$(mktemp -d /var/cache/echo-document-extractor/model-sync.XXXXXX)
cleanup() {
  [[ "$temporary" == /var/cache/echo-document-extractor/model-sync.* ]] \
    && rm -rf -- "$temporary"
}
trap cleanup EXIT

if [[ -z ${AWS_ACCESS_KEY_ID:-} || -z ${AWS_SECRET_ACCESS_KEY:-} ]]; then
  if (( legacy )); then
    "$(dirname "${BASH_SOURCE[0]}")/verify-models.sh" "$active" >/dev/null
    printf 'verified legacy model set; remote credentials were not supplied\n'
    exit 0
  fi
  printf 'read-only model credentials are required\n' >&2
  exit 1
fi
manifest="$temporary/manifest.json"
if ! "$s5cmd" --endpoint-url "$endpoint" cp "$prefix/manifest.json" "$manifest" \
  >/dev/null 2>&1; then
  if (( legacy )); then
    "$(dirname "${BASH_SOURCE[0]}")/verify-models.sh" "$active" >/dev/null
    printf 'verified legacy model set; remote manifest is not published yet\n'
    exit 0
  fi
  printf 'could not download the model manifest\n' >&2
  exit 1
fi
identifier=$(/usr/bin/python3 "$tool" id --manifest "$manifest")
if [[ -f "$active/manifest.json" ]] \
  && [[ $(/usr/bin/python3 "$tool" id --manifest "$active/manifest.json") == "$identifier" ]]; then
  "$(dirname "${BASH_SOURCE[0]}")/verify-models.sh" "$active" >/dev/null
  printf 'model set %s is already active\n' "$identifier"
  exit 0
fi
if (( legacy )); then
  /usr/bin/python3 "$tool" prime --manifest "$manifest" --source "$active" --objects "$objects" \
    >/dev/null
fi

while IFS=$'\t' read -r digest size relative; do
  [[ -n ${digest:-} ]] || continue
  download="$temporary/$digest"
  "$s5cmd" --endpoint-url "$endpoint" cp "$prefix/$relative" "$download"
  [[ $(stat -c %s "$download") == "$size" ]] \
    || { printf 'downloaded model size mismatch: %s\n' "$relative" >&2; exit 1; }
  printf '%s  %s\n' "$digest" "$download" | sha256sum --check --status - \
    || { printf 'downloaded model checksum mismatch: %s\n' "$relative" >&2; exit 1; }
  install -m 0444 "$download" "$objects/$digest"
done < <(/usr/bin/python3 "$tool" missing --manifest "$manifest" --objects "$objects")

destination="$store/$identifier"
if [[ ! -d "$destination" ]]; then
  staging="$store/.$identifier.$$.tmp"
  /usr/bin/python3 "$tool" materialize \
    --manifest "$manifest" --objects "$objects" --destination "$staging"
  /usr/bin/python3 "$tool" verify --manifest "$staging/manifest.json" --root "$staging"
  mv "$staging" "$destination"
fi
if (( legacy )); then
  legacy_identifier=$(sha256sum "$active/SHA256SUMS" | cut -c1-16)
  mv "$active" "$store/legacy-package-$legacy_identifier"
  if dpkg-query -W -f='${db:Status-Abbrev}' echo-document-extractor-models 2>/dev/null \
    | grep -q '^ii'; then
    dpkg --purge echo-document-extractor-models
  fi
fi
link=/opt/echo-document-extractor/.models.$$.tmp
ln -s "$destination" "$link"
mv -Tf "$link" "$active"
"$(dirname "${BASH_SOURCE[0]}")/verify-models.sh" "$active" >/dev/null
printf 'activated model set %s\n' "$identifier"
