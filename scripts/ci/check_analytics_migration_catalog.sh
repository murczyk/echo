#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
cd "$REPO_ROOT"

base=${GITHUB_BASE_REF:+origin/$GITHUB_BASE_REF}
base=${base:-HEAD^}
base_revision=$(git merge-base "$base" HEAD)
changed_paths=$(
  {
    git diff --name-only --diff-filter=AM "$base...HEAD"
    git diff --name-only --diff-filter=AM
    git diff --cached --name-only --diff-filter=AM
    git ls-files --others --exclude-standard
  } | sort -u
)
if ! grep -Eq '^(echo-migration/src/m[0-9a-z_]+\.rs|wdintel-rs/Cargo\.toml)$' \
  <<<"$changed_paths"
then
  echo "No migration or migration dependency changes; skipping catalog comparison"
  exit 0
fi

: "${TEST_DB_NAME:?TEST_DB_NAME is required}"

catalog_dir=$(mktemp -d "$REPO_ROOT/target/analytics-migration-catalog.XXXXXX")
base_worktree="$catalog_dir/base"
base_target_dir="$catalog_dir/target-base"
before="$catalog_dir/before.tsv"
after="$catalog_dir/after.tsv"

cleanup() {
  git worktree remove --force "$base_worktree" >/dev/null 2>&1 || true
  rm -rf -- "$catalog_dir"
}
trap cleanup EXIT

git worktree add --detach "$base_worktree" "$base_revision" >/dev/null

echo "Applying base migrations for analytics catalog comparison"
(
  cd "$base_worktree"
  CARGO_TARGET_DIR="$base_target_dir" \
    cargo run -p wdintel-rs -- --mode=test migrate
)

snapshot_catalog() {
  psql \
    -h "${PG_HOST:-localhost}" \
    -p "${PG_PORT:-5432}" \
    -U "${PG_USER:-wd}" \
    -d "$TEST_DB_NAME" \
    -X -Atq -F $'\t' <<'SQL'
SELECT namespace.nspname || '.' || relation.relname,
       attribute.attname,
       pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
       attribute.attnotnull,
       coalesce(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid), '')
FROM pg_catalog.pg_class relation
JOIN pg_catalog.pg_namespace namespace
  ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_attribute attribute
  ON attribute.attrelid = relation.oid
 AND attribute.attnum > 0
 AND NOT attribute.attisdropped
LEFT JOIN pg_catalog.pg_attrdef default_value
  ON default_value.adrelid = relation.oid
 AND default_value.adnum = attribute.attnum
WHERE relation.relkind IN ('r', 'p')
  AND namespace.nspname <> 'information_schema'
  AND namespace.nspname !~ '^pg_'
ORDER BY 1, attribute.attnum;
SQL
}

snapshot_catalog >"$before"

echo "Applying proposed migrations for analytics catalog comparison"
cargo run -p wdintel-rs -- --mode=test migrate
snapshot_catalog >"$after"

python3 scripts/ci/check_analytics_migrations.py \
  --base "$base" \
  --catalog-before "$before" \
  --catalog-after "$after"
