#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REPOSITORY_DIR=$(cd "$PROJECT_DIR/.." && pwd)
TARGET_HOST=${1:-${TARGET_HOST:-echo-document-extractor}}
app=$(find "$PROJECT_DIR/dist" -maxdepth 1 -name 'echo-document-extractor_*_amd64.deb' \
  ! -name '*models*' -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)
[[ -n "$app" ]] || { printf 'build the application Debian package first\n' >&2; exit 1; }
[[ -f "$REPOSITORY_DIR/.env" ]] || { printf 'repository .env is required for model access\n' >&2; exit 1; }
set -a
# shellcheck disable=SC1091
source "$REPOSITORY_DIR/.env"
set +a
: "${ECHOUASTORAGE_LFS_RO_AWS_ACCESS_KEY_ID:?missing read-only LFS access key in .env}"
: "${ECHOUASTORAGE_LFS_RO_AWS_SECRET_ACCESS_KEY:?missing read-only LFS secret key in .env}"
"$SCRIPT_DIR/preflight.sh" "$TARGET_HOST"
app_sha=$(sha256sum "$app" | awk '{print $1}')
current_app=$(ssh -o BatchMode=yes "$TARGET_HOST" \
  "sudo awk '\$1 == \"application\" {print \$2}' /var/lib/echo-document-extractor/deployed-package-sha256 2>/dev/null" \
  || true)

credentials=$(mktemp /tmp/echo-document-extractor-model-ro.XXXXXX)
chmod 0600 "$credentials"
printf 'AWS_ACCESS_KEY_ID=%q\nAWS_SECRET_ACCESS_KEY=%q\n' \
  "$ECHOUASTORAGE_LFS_RO_AWS_ACCESS_KEY_ID" \
  "$ECHOUASTORAGE_LFS_RO_AWS_SECRET_ACCESS_KEY" >"$credentials"
remote=$(ssh -o BatchMode=yes "$TARGET_HOST" mktemp -d /tmp/echo-document-extractor-deploy.XXXXXX)
[[ "$remote" =~ ^/tmp/echo-document-extractor-deploy\.[A-Za-z0-9]+$ ]] \
  || { printf 'target returned unsafe staging path\n' >&2; exit 1; }
cleanup() {
  [[ "$credentials" == /tmp/echo-document-extractor-model-ro.* ]] && rm -f -- "$credentials"
  ssh -o BatchMode=yes "$TARGET_HOST" rm -rf -- "$remote" >/dev/null 2>&1 || true
}
trap cleanup EXIT
app_name=-
if [[ "$current_app" != "$app_sha" ]]; then
  app_name=$(basename "$app")
  scp -q "$app" "$TARGET_HOST:$remote/"
fi
scp -q "$credentials" "$TARGET_HOST:$remote/model-ro.env"
config_name=-
if [[ -n ${CONFIG_FILE:-} ]]; then
  config_name=config.yaml
  scp -q "$CONFIG_FILE" "$TARGET_HOST:$remote/$config_name"
fi
ssh -o BatchMode=yes "$TARGET_HOST" sudo bash -s -- \
  "$remote" "$app_name" "$app_sha" "$config_name" <<'REMOTE'
set -euo pipefail
remote=$1
app=$2
app_sha=$3
config_name=$4
manifest=/var/lib/echo-document-extractor/deployed-package-sha256
install -d -m 0700 /var/lib/echo-document-extractor
current_app=$(awk '$1 == "application" {print $2}' "$manifest" 2>/dev/null || true)
app_changed=0
config_changed=0
if [[ "$current_app" != "$app_sha" ]]; then
  app_changed=1
fi
if [[ "$config_name" != - ]] && ! cmp -s "$remote/$config_name" /etc/echo-document-extractor/config.yaml; then
  config_changed=1
fi
if (( app_changed || config_changed )); then
  systemctl stop echo-document-extractor-worker.service echo-document-extractor.service || true
fi
if (( app_changed )); then
  [[ "$app" != - && -f "$remote/$app" ]] \
    || { printf 'changed application package was not uploaded\n' >&2; exit 1; }
  systemctl stop echo-document-extractor-otel.service \
    echo-document-extractor-host-cpu-exporter.service || true
  apt-get install -y --allow-downgrades "$remote/$app"
  printf 'application %s\n' "$app_sha" >"$manifest"
  chmod 0600 "$manifest"
fi
if (( config_changed )); then
  install -m 0640 -o root -g echo-document-extractor \
    "$remote/$config_name" /etc/echo-document-extractor/config.yaml
fi

runtime_before=$(readlink -f /opt/echo-document-extractor/runtime/current 2>/dev/null || true)
/opt/echo-document-extractor/bin/sync-runtime.sh >/dev/null
runtime_after=$(readlink -f /opt/echo-document-extractor/runtime/current)
models_before=$(/opt/echo-document-extractor/bin/verify-models.sh 2>/dev/null || true)
set -a
# shellcheck disable=SC1091
source /etc/echo-document-extractor/models.env
# shellcheck disable=SC1091
source "$remote/model-ro.env"
set +a
/opt/echo-document-extractor/bin/sync-models.sh
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
models_after=$(/opt/echo-document-extractor/bin/verify-models.sh)
/opt/echo-document-extractor/bin/verify-offline-paddle.sh

if ! /opt/echo-document-extractor/bin/configure-firewall.sh check >/dev/null 2>&1; then
  systemctl stop echo-document-extractor.service || true
  /opt/echo-document-extractor/bin/configure-firewall.sh apply
fi
systemctl start echo-document-extractor-firewall.service echo-document-extractor.service \
  echo-document-extractor-worker.service \
  echo-document-extractor-host-cpu-exporter.service \
  echo-document-extractor-otel.service
if (( ! app_changed && ! config_changed )) \
  && [[ "$runtime_before" != "$runtime_after" || "$models_before" != "$models_after" ]]; then
  systemctl restart echo-document-extractor-worker.service echo-document-extractor.service
fi
REMOTE
"$SCRIPT_DIR/verify.sh" "$TARGET_HOST"
