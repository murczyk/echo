#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_versions

artifact_dir=${1:?usage: build-gateway-extension.sh OUTPUT_DIRECTORY}
pg_config=/usr/lib/postgresql/$POSTGRESQL_MAJOR/bin/pg_config
for command in git make python3 sha256sum tar ldd; do
  require_cmd "$command"
done
[[ $($pg_config --version) == "PostgreSQL $POSTGRESQL_MAJOR"* ]] \
  || die "expected PostgreSQL $POSTGRESQL_MAJOR build tools"
mkdir -p "$artifact_dir"
artifact_dir=$(realpath "$artifact_dir")
archive="pg_clickhouse-${PG_CLICKHOUSE_VERSION}-pg${POSTGRESQL_MAJOR}-extension-only.tar.gz"
[[ ! -e "$artifact_dir/$archive" ]] || die "artifact already exists; reuse its recorded checksum"
work_dir=$(mktemp -d)
trap 'rm -rf -- "$work_dir"' EXIT
git init -q "$work_dir/source"
git -C "$work_dir/source" remote add origin "$PG_CLICKHOUSE_GIT_URL"
git -C "$work_dir/source" fetch -q --depth 1 origin "$PG_CLICKHOUSE_GIT_COMMIT"
git -C "$work_dir/source" checkout -q --detach FETCH_HEAD
[[ $(git -C "$work_dir/source" rev-parse HEAD) == "$PG_CLICKHOUSE_GIT_COMMIT" ]] \
  || die "source commit mismatch"
git -C "$work_dir/source" submodule update --init --depth 1
make -C "$work_dir/source" -j"$(nproc)" PG_CONFIG="$pg_config"
mkdir "$work_dir/artifact"
install -m 0755 "$work_dir/source/pg_clickhouse.so" "$work_dir/artifact/pg_clickhouse.so"
install -m 0644 "$work_dir/source/LICENSE.md" "$work_dir/artifact/LICENSE.md"
ldd "$work_dir/artifact/pg_clickhouse.so" > "$artifact_dir/ldd.txt"
! grep -q 'not found' "$artifact_dir/ldd.txt" || die "extension dependency is missing"
python3 - "$work_dir/artifact" "$PG_CLICKHOUSE_GIT_COMMIT" "$PG_CLICKHOUSE_VERSION" "$POSTGRESQL_MAJOR" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
metadata = {"commit": sys.argv[2], "version": sys.argv[3], "postgresql_major": int(sys.argv[4]),
            "library_sha256": hashlib.sha256((root / "pg_clickhouse.so").read_bytes()).hexdigest()}
(root / "build-info.json").write_text(json.dumps(metadata, indent=2) + "\n")
PY
tar --sort=name --owner=0 --group=0 --numeric-owner \
  -C "$work_dir/artifact" -czf "$artifact_dir/$archive" pg_clickhouse.so LICENSE.md build-info.json
cp "$work_dir/artifact/build-info.json" "$artifact_dir/build-info.json"
(cd "$artifact_dir" && sha256sum "$archive" > SHA256SUMS)
log "Extension-only artifact: $artifact_dir/$archive"
