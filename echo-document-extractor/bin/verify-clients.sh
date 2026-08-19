#!/usr/bin/env bash
set -euo pipefail
EXTRACTOR_HOST=${EXTRACTOR_HOST:-echo-document-extractor}
clients=(echo-staging echo-cbr-staging echo-cbr echo-siversk echo-zp2 echo-skhid echo-pivnich)
token=$(ssh -o BatchMode=yes "$EXTRACTOR_HOST" \
  "sudo awk -F= '\$1 == \"ECHO_DOCUMENT_EXTRACTOR_TOKEN\" {print substr(\$0, index(\$0, \"=\") + 1)}' /etc/echo-document-extractor/secret.env")
[[ -n "$token" ]] || { printf 'extractor token is unavailable\n' >&2; exit 1; }
for client in "${clients[@]}"; do
  printf 'Verifying %s\n' "$client"
  printf '%s\n%s\n' "$token" "$client" | ssh -o BatchMode=yes "$client" '
    set -euo pipefail
    read -r token
    read -r expected_instance_id
    base=http://100.93.77.92:8000
    curl -fsS --max-time 10 "$base/health/live" >/dev/null
    [[ $(curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer invalid" "$base/v1/status") == 401 ]]
    curl -fsS --max-time 10 -H "Authorization: Bearer $token" "$base/v1/status" >/dev/null

    ocr_block=$(awk '"'"'
      /^\[ocr\]$/ { in_ocr=1; next }
      /^\[/ { in_ocr=0 }
      in_ocr { print }
    '"'"' /etc/echo/config.toml)
    selected_engine_count=$(sudo -u postgres psql -d wd -Atc \
      "select count(*) from ocr_settings_ai_engine where ocr_settings_id = 1" \
      2>/dev/null || printf "0")
    if [[ "$selected_engine_count" -gt 0 ]]; then
      [[ -n "$ocr_block" ]] || {
        printf "OCR engines are selected but the [ocr] config block is missing\\n" >&2
        exit 1
      }
      instance_id=$(printf "%s\\n" "$ocr_block" | sed -n "s/^instance_id = \\\"\\([^\\\"]*\\)\\\"/\\1/p")
      gateway_url=$(printf "%s\\n" "$ocr_block" | sed -n "s/^gateway_url = \\\"\\([^\\\"]*\\)\\\"/\\1/p")
      gateway_host=$(printf "%s\\n" "$gateway_url" | sed -E "s#^[[:alpha:]][[:alnum:]+.-]*://([^/:]+).*#\\1#")
      local_ip=$(tailscale ip -4)
      [[ "$instance_id" == "$expected_instance_id" ]] || {
        printf "OCR instance_id mismatch: expected %s, got %s\\n" "$expected_instance_id" "$instance_id" >&2
        exit 1
      }
      [[ "$gateway_host" == "$local_ip" ]] || {
        printf "OCR gateway URL must target this host: expected %s, got %s\\n" "$local_ip" "$gateway_host" >&2
        exit 1
      }
    fi
  '
done
printf 'Client authentication verification passed on all seven Echo hosts\n'
