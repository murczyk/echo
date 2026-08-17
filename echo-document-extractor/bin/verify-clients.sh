#!/usr/bin/env bash
set -euo pipefail
EXTRACTOR_HOST=${EXTRACTOR_HOST:-echo-document-extractor}
clients=(echo-staging echo-cbr-staging echo-cbr echo-siversk echo-zp2 echo-skhid echo-pivnich)
token=$(ssh -o BatchMode=yes "$EXTRACTOR_HOST" \
  "sudo awk -F= '\$1 == \"ECHO_DOCUMENT_EXTRACTOR_TOKEN\" {print substr(\$0, index(\$0, \"=\") + 1)}' /etc/echo-document-extractor/secret.env")
[[ -n "$token" ]] || { printf 'extractor token is unavailable\n' >&2; exit 1; }
for client in "${clients[@]}"; do
  printf 'Verifying %s\n' "$client"
  printf '%s\n' "$token" | ssh -o BatchMode=yes "$client" '
    set -euo pipefail
    read -r token
    base=http://100.93.77.92:8000
    curl -fsS --max-time 10 "$base/health/live" >/dev/null
    [[ $(curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer invalid" "$base/v1/status") == 401 ]]
    curl -fsS --max-time 10 -H "Authorization: Bearer $token" "$base/v1/status" >/dev/null
  '
done
printf 'Client authentication verification passed on all seven Echo hosts\n'
