#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config
read_source_tables

declare -A target_lookup=()
for table in "${SOURCE_TABLES[@]}"; do
  schema=${table%%.*}
  relation=${table##*.}
  target=$relation
  [[ "$schema" == public ]] || target="${schema}__${relation}"
  target_lookup["$target"]=$table
done

declare -A raw_lookup=()
while IFS= read -r table; do
  [[ -n "$table" ]] && raw_lookup["$table"]=1
done < <(clickhouse_admin --format TSVRaw --query \
  "SELECT name FROM system.tables WHERE database = '$CLICKHOUSE_RAW_DB' ORDER BY name")

missing=0
unexpected=0
for target in "${!target_lookup[@]}"; do
  if [[ -z "${raw_lookup[$target]:-}" ]]; then
    printf 'MISSING  %-48s -> %s\n' "${target_lookup[$target]}" "$target"
    missing=$((missing + 1))
  fi
done
for target in "${!raw_lookup[@]}"; do
  if [[ -z "${target_lookup[$target]:-}" ]]; then
    if [[ "$target" == _peerdb_* ]]; then
      printf 'INTERNAL %s.%s\n' "$CLICKHOUSE_RAW_DB" "$target"
    else
      printf 'EXTRA    %s.%s\n' "$CLICKHOUSE_RAW_DB" "$target"
      unexpected=$((unexpected + 1))
    fi
  fi
done
printf 'Selected source tables: %s; missing raw tables: %s; unexpected raw tables: %s\n' \
  "${#SOURCE_TABLES[@]}" "$missing" "$unexpected"
((missing == 0 && unexpected == 0))
