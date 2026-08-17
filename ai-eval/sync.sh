#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
direction="${1:-}"
evaluation="${2:-}"

case "$direction" in
  from-cloud | to-cloud) ;;
  *)
    echo "Usage: $0 <from-cloud|to-cloud> [YYYY-MM-DD-evaluation]" >&2
    exit 1
    ;;
esac

validate_evaluation_name() {
  local evaluation="$1"

  if [[ ! "$evaluation" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]*$ ]]; then
    echo "Invalid evaluation name: $evaluation" >&2
    return 1
  fi

  if ! date -u -d "${evaluation:0:10}" '+%F' >/dev/null 2>&1; then
    echo "Invalid evaluation date: ${evaluation:0:10}" >&2
    return 1
  fi
}

if [[ -n "$evaluation" ]]; then
  validate_evaluation_name "$evaluation"
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

endpoint_url="https://s3.eu-central-003.backblazeb2.com"
remote_evaluations="s3://echouastorage/lfs/echo-ai/evals"
s5cmd_args=(
  --retry-count 10
  --numworkers 4
  --endpoint-url "$endpoint_url"
)

find_evaluation_dir() {
  local evaluation="$1"

  if [[ -d "$repo_root/ai-eval/$evaluation" ]]; then
    printf '%s\n' "$repo_root/ai-eval/$evaluation"
  elif [[ -d "$repo_root/archive/$evaluation" ]]; then
    printf '%s\n' "$repo_root/archive/$evaluation"
  else
    echo "Evaluation not found in ai-eval/ or archive/: $evaluation" >&2
    return 1
  fi
}

sync_from_cloud() {
  local evaluation="$1"
  local evaluation_dir="$2"
  local local_raw="$evaluation_dir/raw"
  local remote_raw="$remote_evaluations/$evaluation"

  mkdir -p "$local_raw"
  echo "Syncing $evaluation from Backblaze"
  s5cmd "${s5cmd_args[@]}" sync --size-only --part-size 100 --concurrency 1 \
    "$remote_raw/*" "$local_raw/"
}

sync_to_cloud() {
  local evaluation="$1"
  local evaluation_dir="$2"
  local local_raw="$evaluation_dir/raw"
  local remote_raw="$remote_evaluations/$evaluation"

  if [[ ! -d "$local_raw" ]] || ! find "$local_raw" -type f -print -quit | grep -q .; then
    echo "No raw evaluation files found in $local_raw" >&2
    return 1
  fi
  echo "Syncing $evaluation to Backblaze"
  s5cmd "${s5cmd_args[@]}" sync --size-only --part-size 100 --concurrency 1 \
    "$local_raw/" "$remote_raw/"
}

if [[ -n "$evaluation" ]]; then
  evaluation_dir="$(find_evaluation_dir "$evaluation")"
  if [[ "$direction" == "from-cloud" ]]; then
    sync_from_cloud "$evaluation" "$evaluation_dir"
  else
    sync_to_cloud "$evaluation" "$evaluation_dir"
  fi
elif [[ "$direction" == "from-cloud" ]]; then
  remote_evaluation_dirs="$(s5cmd "${s5cmd_args[@]}" ls --show-fullpath "$remote_evaluations/")"
  synced_count=0
  while IFS= read -r remote_evaluation_dir; do
    [[ "$remote_evaluation_dir" == "$remote_evaluations/"* ]] || continue
    [[ "$remote_evaluation_dir" == */ ]] || continue
    evaluation="${remote_evaluation_dir#"$remote_evaluations/"}"
    evaluation="${evaluation%/}"
    [[ "$evaluation" != */* ]] || continue
    validate_evaluation_name "$evaluation" >/dev/null 2>&1 || continue
    if ! evaluation_dir="$(find_evaluation_dir "$evaluation" 2>/dev/null)"; then
      evaluation_dir="$repo_root/ai-eval/$evaluation"
      mkdir -p "$evaluation_dir"
      echo "Creating local evaluation directory: $evaluation_dir"
    fi
    sync_from_cloud "$evaluation" "$evaluation_dir"
    synced_count=$((synced_count + 1))
  done <<<"$remote_evaluation_dirs"
  if ((synced_count == 0)); then
    echo "No Backblaze evaluations found under $remote_evaluations/" >&2
    exit 1
  fi
else
  declare -A synced_evaluations=()
  synced_count=0
  for evaluations_dir in "$repo_root/ai-eval" "$repo_root/archive"; do
    [[ -d "$evaluations_dir" ]] || continue
    while IFS= read -r -d '' evaluation_dir; do
      evaluation="${evaluation_dir##*/}"
      validate_evaluation_name "$evaluation" >/dev/null 2>&1 || continue
      [[ -z "${synced_evaluations[$evaluation]:-}" ]] || continue
      [[ -d "$evaluation_dir/raw" ]] || continue
      find "$evaluation_dir/raw" -type f -print -quit | grep -q . || continue
      sync_to_cloud "$evaluation" "$evaluation_dir"
      synced_evaluations[$evaluation]=1
      synced_count=$((synced_count + 1))
    done < <(find "$evaluations_dir" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
  done
  if ((synced_count == 0)); then
    echo "No local raw evaluation files found in ai-eval/ or archive/" >&2
    exit 1
  fi
fi
