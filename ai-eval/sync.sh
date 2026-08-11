#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
direction="${1:-}"
evaluation="${2:-}"

case "$direction" in
  from-cloud | to-cloud) ;;
  *)
    echo "Usage: $0 <from-cloud|to-cloud> <YYYY-MM-DD-evaluation>" >&2
    exit 1
    ;;
esac

if [[ ! "$evaluation" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Invalid evaluation name: $evaluation" >&2
  exit 1
fi

if ! date -u -d "${evaluation:0:10}" '+%F' >/dev/null 2>&1; then
  echo "Invalid evaluation date: ${evaluation:0:10}" >&2
  exit 1
fi

if ! command -v s5cmd >/dev/null 2>&1; then
  echo "s5cmd is required: https://github.com/peak/s5cmd" >&2
  exit 1
fi

exported_access_key="${AWS_ACCESS_KEY_ID:-}"
exported_secret_key="${AWS_SECRET_ACCESS_KEY:-}"
if [[ ( -z "$exported_access_key" || -z "$exported_secret_key" ) && -f "$repo_root/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$repo_root/.env"
  set +a
fi
if [[ -n "$exported_access_key" ]]; then
  export AWS_ACCESS_KEY_ID="$exported_access_key"
fi
if [[ -n "$exported_secret_key" ]]; then
  export AWS_SECRET_ACCESS_KEY="$exported_secret_key"
fi
if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
  echo "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required" >&2
  exit 1
fi

local_raw="$repo_root/ai-eval/$evaluation/raw"
remote_raw="s3://echouastorage/lfs/echo-ai/evals/$evaluation"
endpoint_url="https://s3.eu-central-003.backblazeb2.com"
s5cmd_args=(
  --retry-count 10
  --numworkers 4
  --endpoint-url "$endpoint_url"
)
mkdir -p "$local_raw"

if [[ "$direction" == "from-cloud" ]]; then
  s5cmd "${s5cmd_args[@]}" sync --part-size 100 --concurrency 1 \
    "$remote_raw/*" "$local_raw/"
else
  if ! find "$local_raw" -type f -print -quit | grep -q .; then
    echo "No raw evaluation files found in $local_raw" >&2
    exit 1
  fi
  s5cmd "${s5cmd_args[@]}" sync --part-size 100 --concurrency 1 \
    "$local_raw/" "$remote_raw/"
fi
