#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_versions

ARTIFACT_DIR=${1:-$BUNDLE_DIR/build/artifacts}
require_file "$ARTIFACT_DIR/SHA256SUMS"
require_cmd find
require_cmd ldd
require_cmd sha256sum
require_cmd stat
require_cmd tar

peerdb_archive="peerdb-${PEERDB_VERSION}-linux-amd64.tar.gz"
pgch_archive="pg_clickhouse-${PG_CLICKHOUSE_VERSION}-pg${POSTGRESQL_MAJOR}-linux-amd64.tar.gz"
minio_archive="minio-${MINIO_VERSION}-linux-amd64.tar.gz"
mc_archive="mc-${MCLI_VERSION}-linux-amd64.tar.gz"

for archive in "$peerdb_archive" "$pgch_archive" "$minio_archive" "$mc_archive"; do
  require_file "$ARTIFACT_DIR/$archive"
done

(
  cd "$ARTIFACT_DIR"
  sha256sum --check SHA256SUMS
)

validate_archive() {
  local archive=$1
  local member
  while IFS= read -r member; do
    [[ "$member" != /* ]] || die "absolute archive path in $archive: $member"
    [[ "/$member/" != *"/../"* ]] || die "parent traversal in $archive: $member"
  done < <(tar -tzf "$archive")
}

for archive in "$peerdb_archive" "$pgch_archive" "$minio_archive" "$mc_archive"; do
  validate_archive "$ARTIFACT_DIR/$archive"
done

tmp_dir=$(mktemp -d /tmp/echo-analytics-artifacts.XXXXXX)
trap 'rm -rf -- "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/peerdb" "$tmp_dir/minio" "$tmp_dir/mc"
tar -xzf "$ARTIFACT_DIR/$peerdb_archive" -C "$tmp_dir/peerdb"
tar -xzf "$ARTIFACT_DIR/$minio_archive" -C "$tmp_dir/minio"
tar -xzf "$ARTIFACT_DIR/$mc_archive" -C "$tmp_dir/mc"

for binary in "$tmp_dir/peerdb/bin/peer-flow" "$tmp_dir/peerdb/bin/peerdb-server"; do
  [[ -x "$binary" ]] || die "artifact is missing $binary"
  if ldd "$binary" 2>&1 | grep -q 'not found'; then
    ldd "$binary" >&2
    die "runtime dependency missing for $binary"
  fi
done

sudo install -d -m 0755 /opt/peerdb/bin /usr/local/bin
sudo install -m 0755 "$tmp_dir/peerdb/bin/peer-flow" /opt/peerdb/bin/peer-flow
sudo install -m 0755 "$tmp_dir/peerdb/bin/peerdb-server" /opt/peerdb/bin/peerdb-server
sudo install -m 0755 "$tmp_dir/minio/bin/minio" /usr/local/bin/minio
sudo install -m 0755 "$tmp_dir/mc/bin/mc" /usr/local/bin/mc

log "Installing pg_clickhouse files for PostgreSQL $POSTGRESQL_MAJOR"
sudo tar \
  --no-overwrite-dir \
  --no-same-owner \
  --no-same-permissions \
  -xzf "$ARTIFACT_DIR/$pgch_archive" \
  -C /
pgch_so=/usr/lib/postgresql/$POSTGRESQL_MAJOR/lib/pg_clickhouse.so
[[ -f "$pgch_so" ]] || die "pg_clickhouse artifact did not install $pgch_so"

for path in \
  /usr \
  /usr/lib \
  /usr/lib/postgresql \
  "/usr/lib/postgresql/$POSTGRESQL_MAJOR" \
  "/usr/lib/postgresql/$POSTGRESQL_MAJOR/lib" \
  "$pgch_so" \
  /usr/share \
  /usr/share/postgresql \
  "/usr/share/postgresql/$POSTGRESQL_MAJOR" \
  "/usr/share/postgresql/$POSTGRESQL_MAJOR/extension" \
  "/usr/share/postgresql/$POSTGRESQL_MAJOR/extension/pg_clickhouse.control" \
  /usr/share/doc \
  /usr/share/doc/pg_clickhouse \
  "/usr/share/doc/postgresql-doc-$POSTGRESQL_MAJOR"
do
  [[ $(stat -c '%U:%G' "$path") == root:root ]] \
    || die "pg_clickhouse install path is not root-owned: $path"
  mode=$(stat -c '%a' "$path")
  (( (8#$mode & 0022) == 0 )) \
    || die "pg_clickhouse install path is group/world-writable: $path"
done

for path in \
  "/usr/lib/postgresql/$POSTGRESQL_MAJOR/lib/bitcode/pg_clickhouse" \
  "/usr/share/doc/pg_clickhouse" \
  "/usr/share/doc/postgresql-doc-$POSTGRESQL_MAJOR/extension"
do
  insecure_path=$(find "$path" \
    \( ! -user root -o ! -group root -o -perm /0022 \) -print -quit)
  [[ -z "$insecure_path" ]] \
    || die "insecure pg_clickhouse artifact path: $insecure_path"
done
for path in \
  "/usr/lib/postgresql/$POSTGRESQL_MAJOR/lib/bitcode/pg_clickhouse.index.bc" \
  "/usr/share/postgresql/$POSTGRESQL_MAJOR/extension"/pg_clickhouse*.sql
do
  [[ -f "$path" ]] || die "missing pg_clickhouse artifact file: $path"
  [[ $(stat -c '%U:%G' "$path") == root:root ]] \
    || die "pg_clickhouse artifact file is not root-owned: $path"
  mode=$(stat -c '%a' "$path")
  (( (8#$mode & 0022) == 0 )) \
    || die "pg_clickhouse artifact file is group/world-writable: $path"
done
if ldd "$pgch_so" 2>&1 | grep -q 'not found'; then
  ldd "$pgch_so" >&2
  die "runtime dependency missing for $pgch_so"
fi

/opt/peerdb/bin/peer-flow --help >/dev/null
/opt/peerdb/bin/peerdb-server --help >/dev/null
/usr/local/bin/minio --version
/usr/local/bin/mc --version

log "Runtime artifacts installed and ABI smoke checks passed"
