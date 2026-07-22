#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_versions

TOOLCHAIN_ROOT=${ECHO_CLICKHOUSE_TOOLCHAIN_ROOT:-$HOME/.local/share/echo-clickhouse-toolchains}
BUILD_ROOT=${ECHO_CLICKHOUSE_BUILD_ROOT:-/srv/echo-clickhouse-build/$PEERDB_VERSION}
SOURCE_ROOT=${ECHO_CLICKHOUSE_SOURCE_ROOT:-$HOME/workspace/echo-clickhouse-sources}
ARTIFACT_DIR=$BUILD_ROOT/artifacts
REPORT_DIR=$BUILD_ROOT/reports

export PATH="$TOOLCHAIN_ROOT/go-$GO_VERSION/bin:$TOOLCHAIN_ROOT/cargo/bin:$TOOLCHAIN_ROOT/bin:$PATH"
export RUSTUP_HOME="$TOOLCHAIN_ROOT/rustup"
export CARGO_HOME="$TOOLCHAIN_ROOT/cargo"
export GOTOOLCHAIN=local

for command in buf cargo cmake curl gcc git go ldd make pg_config sha256sum tar; do
  require_cmd "$command"
done

[[ $(go env GOVERSION) == "go$GO_VERSION" ]] || die "expected Go $GO_VERSION"
[[ $(rustc --version | awk '{print $2}') == "$RUST_VERSION" ]] || die "expected Rust $RUST_VERSION"
[[ $(buf --version) == "$BUF_VERSION" ]] || die "expected buf $BUF_VERSION"
PG_CONFIG=/usr/lib/postgresql/$POSTGRESQL_MAJOR/bin/pg_config
[[ -x "$PG_CONFIG" ]] \
  || die "missing PostgreSQL $POSTGRESQL_MAJOR pg_config: $PG_CONFIG"
[[ $($PG_CONFIG --version) == "PostgreSQL $POSTGRESQL_MAJOR"* ]] \
  || die "pg_config is not PostgreSQL $POSTGRESQL_MAJOR"

sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 "$BUILD_ROOT"
mkdir -p "$SOURCE_ROOT" "$ARTIFACT_DIR" "$REPORT_DIR"
rm -f "$ARTIFACT_DIR/manifest.json" "$ARTIFACT_DIR/manifest.txt"
work_dir=$(mktemp -d "$BUILD_ROOT/.build.XXXXXX")
trap 'rm -rf -- "$work_dir"' EXIT

checkout_exact() {
  local url=$1
  local commit=$2
  local destination=$3

  git init -q "$destination"
  git -C "$destination" remote add origin "$url"
  git -C "$destination" fetch -q --depth 1 origin "$commit"
  git -C "$destination" checkout -q --detach FETCH_HEAD
  [[ $(git -C "$destination" rev-parse HEAD) == "$commit" ]] \
    || die "unexpected checkout commit in $destination"
}

log "Building PeerDB $PEERDB_VERSION ($PEERDB_GIT_COMMIT)"
peerdb_src=$work_dir/peerdb
checkout_exact https://github.com/PeerDB-io/peerdb.git "$PEERDB_GIT_COMMIT" "$peerdb_src"
(
  cd "$peerdb_src"
  buf generate protos
  (cd flow && go generate ./...)
  (cd flow && CGO_ENABLED=1 go build -trimpath -o "$work_dir/peer-flow" .)
  (cd nexus && cargo build --locked --release -p peerdb-server)
  install -m 0755 nexus/target/release/peerdb-server "$work_dir/peerdb-server"
)

peerdb_stage=$work_dir/peerdb-stage
install -d "$peerdb_stage/bin" "$peerdb_stage/share/licenses/peerdb"
install -m 0755 "$work_dir/peer-flow" "$peerdb_stage/bin/peer-flow"
install -m 0755 "$work_dir/peerdb-server" "$peerdb_stage/bin/peerdb-server"
install -m 0644 "$peerdb_src/LICENSE" "$peerdb_stage/share/licenses/peerdb/LICENSE"
printf '%s %s\n' "$PEERDB_VERSION" "$PEERDB_GIT_COMMIT" >"$peerdb_stage/VERSION"
peerdb_archive="$ARTIFACT_DIR/peerdb-${PEERDB_VERSION}-linux-amd64.tar.gz"
tar -C "$peerdb_stage" -czf "$peerdb_archive" .

log "Building pg_clickhouse $PG_CLICKHOUSE_VERSION for PostgreSQL $POSTGRESQL_MAJOR"
pgch_src=$work_dir/pg_clickhouse
checkout_exact "$PG_CLICKHOUSE_GIT_URL" "$PG_CLICKHOUSE_GIT_COMMIT" "$pgch_src"
git -C "$pgch_src" submodule update --init --depth 1
(
  cd "$pgch_src"
  make -j"$(nproc)" PG_CONFIG="$PG_CONFIG"
  make PG_CONFIG="$PG_CONFIG" DESTDIR="$work_dir/pgch-stage" install
)
install -d "$work_dir/pgch-stage/usr/share/doc/pg_clickhouse"
install -m 0644 "$pgch_src/LICENSE.md" "$work_dir/pgch-stage/usr/share/doc/pg_clickhouse/LICENSE.md"
find "$work_dir/pgch-stage" -type d -exec chmod 0755 {} +
find "$work_dir/pgch-stage" -type f -exec chmod 0644 {} +
chmod 0755 "$work_dir/pgch-stage/usr/lib/postgresql/$POSTGRESQL_MAJOR/lib/pg_clickhouse.so"
pgch_archive="$ARTIFACT_DIR/pg_clickhouse-${PG_CLICKHOUSE_VERSION}-pg${POSTGRESQL_MAJOR}-linux-amd64.tar.gz"
tar --sort=name --owner=0 --group=0 --numeric-owner \
  -C "$work_dir/pgch-stage" -czf "$pgch_archive" .
find "$ARTIFACT_DIR" -maxdepth 1 -type f \
  -name "pg_clickhouse-${PG_CLICKHOUSE_VERSION}-pg*-linux-amd64.tar.gz" \
  ! -path "$pgch_archive" -delete

log "Building MinIO $MINIO_VERSION ($MINIO_GIT_COMMIT)"
minio_src=$work_dir/minio
checkout_exact https://github.com/minio/minio.git "$MINIO_GIT_COMMIT" "$minio_src"
(
  cd "$minio_src"
  MINIO_RELEASE=RELEASE CGO_ENABLED=0 make build
)
minio_stage=$work_dir/minio-stage
install -d "$minio_stage/bin" "$minio_stage/share/licenses/minio"
install -m 0755 "$minio_src/minio" "$minio_stage/bin/minio"
install -m 0644 "$minio_src/LICENSE" "$minio_stage/share/licenses/minio/LICENSE"

log "Fetching checksummed mc $MCLI_VERSION"
mc_url="https://dl.min.io/client/mc/release/linux-amd64/archive/mc.${MCLI_VERSION}"
curl -fsSL "$mc_url" -o "$work_dir/mc"
printf '%s  %s\n' "$MCLI_LINUX_AMD64_SHA256" "$work_dir/mc" | sha256sum --check
printf '%s %s\n' "$MINIO_VERSION" "$MINIO_GIT_COMMIT" >"$minio_stage/VERSION"
minio_archive="$ARTIFACT_DIR/minio-${MINIO_VERSION}-linux-amd64.tar.gz"
tar -C "$minio_stage" -czf "$minio_archive" .

mc_stage=$work_dir/mc-stage
install -d "$mc_stage/bin"
install -m 0755 "$work_dir/mc" "$mc_stage/bin/mc"
printf '%s\n' "$MCLI_VERSION" >"$mc_stage/VERSION"
mc_archive="$ARTIFACT_DIR/mc-${MCLI_VERSION}-linux-amd64.tar.gz"
tar -C "$mc_stage" -czf "$mc_archive" .

(
  cd "$ARTIFACT_DIR"
  sha256sum \
    "$(basename "$peerdb_archive")" \
    "$(basename "$pgch_archive")" \
    "$(basename "$minio_archive")" \
    "$(basename "$mc_archive")" >SHA256SUMS
)

{
  printf 'built_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'builder=%s\n' "$(hostname -f 2>/dev/null || hostname)"
  printf 'builder_os=%s\n' "$(. /etc/os-release && printf '%s %s' "$ID" "$VERSION_ID")"
  printf 'builder_glibc=%s\n' "$(ldd --version | head -n 1)"
  printf 'go=%s\n' "$(go version)"
  printf 'rust=%s\n' "$(rustc --version)"
  printf 'buf=%s\n' "$(buf --version)"
  printf 'postgres=%s\n' "$($PG_CONFIG --version)"
  printf 'peerdb_commit=%s\n' "$PEERDB_GIT_COMMIT"
  printf 'pg_clickhouse_git_url=%s\n' "$PG_CLICKHOUSE_GIT_URL"
  printf 'pg_clickhouse_commit=%s\n' "$PG_CLICKHOUSE_GIT_COMMIT"
  printf 'minio_commit=%s\n' "$MINIO_GIT_COMMIT"
} >"$BUILD_ROOT/manifest.txt"

ldd "$work_dir/peer-flow" >"$REPORT_DIR/peer-flow.ldd.txt" || true
ldd "$work_dir/peerdb-server" >"$REPORT_DIR/peerdb-server.ldd.txt" || true
ldd "$work_dir/pgch-stage/usr/lib/postgresql/$POSTGRESQL_MAJOR/lib/pg_clickhouse.so" \
  >"$REPORT_DIR/pg_clickhouse.ldd.txt" || true

log "Artifacts written to $ARTIFACT_DIR"
