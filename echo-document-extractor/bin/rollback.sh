#!/usr/bin/env bash
set -euo pipefail
TARGET_HOST=${TARGET_HOST:-echo-document-extractor}
PREVIOUS_APP_DEB=${PREVIOUS_APP_DEB:?path to retained previous application package is required}
app_sha=$(sha256sum "$PREVIOUS_APP_DEB" | awk '{print $1}')
remote=$(ssh -o BatchMode=yes "$TARGET_HOST" mktemp -d /tmp/echo-document-extractor-rollback.XXXXXX)
[[ "$remote" =~ ^/tmp/echo-document-extractor-rollback\.[A-Za-z0-9]+$ ]] || exit 1
trap 'ssh -o BatchMode=yes "$TARGET_HOST" rm -rf -- "$remote" >/dev/null 2>&1 || true' EXIT
scp -q "$PREVIOUS_APP_DEB" "$TARGET_HOST:$remote/"
ssh -o BatchMode=yes "$TARGET_HOST" sudo bash -s -- \
  "$remote/$(basename "$PREVIOUS_APP_DEB")" "$app_sha" <<'REMOTE'
set -euo pipefail
systemctl stop echo-document-extractor-otel.service echo-document-extractor-worker.service \
  echo-document-extractor.service
apt-get install -y --allow-downgrades "$1"
install -d -m 0700 /var/lib/echo-document-extractor
printf 'application %s\n' "$2" \
  >/var/lib/echo-document-extractor/deployed-package-sha256
chmod 0600 /var/lib/echo-document-extractor/deployed-package-sha256
if [[ -x /opt/echo-document-extractor/bin/sync-runtime.sh ]]; then
  /opt/echo-document-extractor/bin/sync-runtime.sh >/dev/null
fi
/opt/echo-document-extractor/bin/verify-offline-paddle.sh
systemctl start echo-document-extractor-firewall.service echo-document-extractor.service \
  echo-document-extractor-worker.service echo-document-extractor-otel.service
REMOTE
"$(dirname "$0")/verify.sh" "$TARGET_HOST"
