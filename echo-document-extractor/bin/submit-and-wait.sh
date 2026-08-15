#!/usr/bin/env bash
set -euo pipefail

INPUT=${1:?input file is required}
BASE_URL=${BASE_URL:-http://100.93.77.92:8000}
TOKEN=${ECHO_DOCUMENT_EXTRACTOR_TOKEN:?ECHO_DOCUMENT_EXTRACTOR_TOKEN is required}
IDEMPOTENCY_KEY=${IDEMPOTENCY_KEY:-$(python3 -c 'import uuid; print(uuid.uuid4())')}
response=$(curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -F "files=@$INPUT" \
  "$BASE_URL/v1/jobs")
job_id=$(jq -er .id <<<"$response")
while true; do
  response=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/v1/jobs/$job_id")
  state=$(jq -er .state <<<"$response")
  case "$state" in
    completed)
      curl -fsS -H "Authorization: Bearer $TOKEN" \
        -o "${OUTPUT_ZIP:-$job_id.zip}" "$BASE_URL/v1/jobs/$job_id/result"
      jq . <<<"$response"
      break
      ;;
    failed | cancelled)
      jq . <<<"$response" >&2
      exit 1
      ;;
  esac
  sleep 5
done
