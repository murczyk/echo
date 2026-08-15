#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
TARGET_HOST=${1:-${TARGET_HOST:-echo-document-extractor}}
app=$(find "$PROJECT_DIR/dist" -maxdepth 1 -name 'echo-document-extractor_*_amd64.deb' \
  ! -name '*models*' -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)
models=$(find "$PROJECT_DIR/dist" -maxdepth 1 -name 'echo-document-extractor-models_*_amd64.deb' \
  -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)
[[ -n "$app" && -n "$models" ]] || { printf 'build both Debian packages first\n' >&2; exit 1; }
app_version=$(dpkg-deb -f "$app" Version)
model_version=$(dpkg-deb -f "$models" Version)
[[ "$app_version" == "$model_version" ]] || { printf 'package versions do not match\n' >&2; exit 1; }
"$SCRIPT_DIR/preflight.sh" "$TARGET_HOST"
remote=$(ssh -o BatchMode=yes "$TARGET_HOST" mktemp -d /tmp/echo-document-extractor-deploy.XXXXXX)
[[ "$remote" =~ ^/tmp/echo-document-extractor-deploy\.[A-Za-z0-9]+$ ]] \
  || { printf 'target returned unsafe staging path\n' >&2; exit 1; }
cleanup() {
  ssh -o BatchMode=yes "$TARGET_HOST" rm -rf -- "$remote" >/dev/null 2>&1 || true
}
trap cleanup EXIT
scp -q "$app" "$models" "$TARGET_HOST:$remote/"
app_sha=$(sha256sum "$app" | awk '{print $1}')
models_sha=$(sha256sum "$models" | awk '{print $1}')
config_name=-
if [[ -n ${CONFIG_FILE:-} ]]; then
  config_name=config.yaml
  scp -q "$CONFIG_FILE" "$TARGET_HOST:$remote/$config_name"
fi
ssh -o BatchMode=yes "$TARGET_HOST" sudo bash -s -- \
  "$remote" "$(basename "$app")" "$app_sha" "$(basename "$models")" "$models_sha" "$config_name" <<'REMOTE'
set -euo pipefail
remote=$1
app=$2
app_sha=$3
models=$4
models_sha=$5
config_name=$6
manifest=/var/lib/echo-document-extractor/deployed-package-sha256
install -d -m 0700 /var/lib/echo-document-extractor
current_app=$(awk '$1 == "application" {print $2}' "$manifest" 2>/dev/null || true)
current_models=$(awk '$1 == "models" {print $2}' "$manifest" 2>/dev/null || true)
packages=()
models_changed=0
app_changed=0
config_changed=0
if [[ "$current_models" != "$models_sha" ]]; then
  models_changed=1
  packages+=("$remote/$models")
fi
if [[ "$current_app" != "$app_sha" ]]; then
  app_changed=1
  packages+=("$remote/$app")
fi
if [[ "$config_name" != - ]] && ! cmp -s "$remote/$config_name" /etc/echo-document-extractor/config.yaml; then
  config_changed=1
fi
if (( app_changed )); then
  systemctl stop echo-document-extractor-otel.service echo-document-extractor-worker.service \
    echo-document-extractor.service || true
elif (( models_changed )); then
  systemctl stop echo-document-extractor-worker.service || true
fi
if (( ${#packages[@]} )); then
  apt-get install -y --allow-downgrades "${packages[@]}"
  printf 'application %s\nmodels %s\n' "$app_sha" "$models_sha" >"$manifest"
  chmod 0600 "$manifest"
fi
if (( config_changed )); then
  install -m 0640 -o root -g echo-document-extractor \
    "$remote/$config_name" /etc/echo-document-extractor/config.yaml
fi
if (( app_changed || models_changed || config_changed )); then
  /opt/echo-document-extractor/bin/verify-offline-paddle.sh
fi
if ! /opt/echo-document-extractor/bin/configure-firewall.sh check >/dev/null 2>&1; then
  systemctl stop echo-document-extractor.service || true
  /opt/echo-document-extractor/bin/configure-firewall.sh apply
fi
systemctl start echo-document-extractor-firewall.service echo-document-extractor.service \
  echo-document-extractor-worker.service echo-document-extractor-otel.service
REMOTE
"$SCRIPT_DIR/verify.sh" "$TARGET_HOST"
