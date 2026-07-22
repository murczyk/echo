#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_versions

require_cmd apt-get

[[ $(dpkg --print-architecture) == amd64 ]] || die "only Debian amd64 is currently supported"
. /etc/os-release
[[ "$ID" == debian && "$VERSION_ID" == 13 ]] \
  || die "runtime bundle is validated only for Debian 13; found $ID $VERSION_ID"

tmp_dir=$(mktemp -d /tmp/echo-analytics-runtime.XXXXXX)
trap 'rm -rf -- "$tmp_dir"' EXIT

log "Installing apt prerequisites"
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  apt-transport-https \
  ca-certificates \
  curl \
  gnupg \
  jq \
  libcurl4t64 \
  libgeos-c1t64 \
  liblz4-1 \
  libssl3t64 \
  libuuid1 \
  libzstd1 \
  nftables \
  openssl \
  rsync \
  tar

require_cmd curl
require_cmd gpg
require_cmd sha256sum

log "Installing the PostgreSQL PGDG repository"
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$tmp_dir/pgdg.asc"
printf '%s  %s\n' "$PGDG_APT_KEY_SHA256" "$tmp_dir/pgdg.asc" | sha256sum --check
sudo install -d -m 0755 /etc/apt/keyrings
gpg --dearmor <"$tmp_dir/pgdg.asc" >"$tmp_dir/pgdg.gpg"
sudo install -m 0644 "$tmp_dir/pgdg.gpg" /etc/apt/keyrings/postgresql.gpg
printf '%s\n' \
  'deb [signed-by=/etc/apt/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt trixie-pgdg main' \
  | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  "postgresql-$POSTGRESQL_MAJOR" \
  "postgresql-client-$POSTGRESQL_MAJOR"

log "Installing ClickHouse LTS $CLICKHOUSE_VERSION"
curl -fsSL https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key \
  -o "$tmp_dir/clickhouse.asc"
printf '%s  %s\n' "$CLICKHOUSE_APT_KEY_SHA256" "$tmp_dir/clickhouse.asc" | sha256sum --check
gpg --dearmor <"$tmp_dir/clickhouse.asc" >"$tmp_dir/clickhouse.gpg"
sudo install -m 0644 "$tmp_dir/clickhouse.gpg" /etc/apt/keyrings/clickhouse.gpg
printf '%s\n' \
  'deb [signed-by=/etc/apt/keyrings/clickhouse.gpg arch=amd64] https://packages.clickhouse.com/deb lts main' \
  | sudo tee /etc/apt/sources.list.d/clickhouse.list >/dev/null
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  "clickhouse-common-static=$CLICKHOUSE_VERSION" \
  "clickhouse-client=$CLICKHOUSE_VERSION" \
  "clickhouse-server=$CLICKHOUSE_VERSION"
sudo apt-mark hold clickhouse-common-static clickhouse-client clickhouse-server >/dev/null

log "Installing checksummed Temporal server $TEMPORAL_VERSION"
temporal_archive="temporal_${TEMPORAL_VERSION}_linux_amd64.tar.gz"
curl -fsSL \
  "https://github.com/temporalio/temporal/releases/download/v${TEMPORAL_VERSION}/${temporal_archive}" \
  -o "$tmp_dir/$temporal_archive"
printf '%s  %s\n' "$TEMPORAL_LINUX_AMD64_SHA256" "$tmp_dir/$temporal_archive" | sha256sum --check
mkdir -p "$tmp_dir/temporal"
tar -xzf "$tmp_dir/$temporal_archive" -C "$tmp_dir/temporal"
sudo install -d -m 0755 /opt/temporal/bin /opt/temporal/schema
for binary in temporal-server temporal-sql-tool tdbg; do
  sudo install -m 0755 "$tmp_dir/temporal/$binary" "/opt/temporal/bin/$binary"
done

log "Installing pinned Temporal PostgreSQL schemas"
temporal_source="temporal-${TEMPORAL_VERSION}-source.tar.gz"
curl -fsSL \
  "https://github.com/temporalio/temporal/archive/refs/tags/v${TEMPORAL_VERSION}.tar.gz" \
  -o "$tmp_dir/$temporal_source"
printf '%s  %s\n' "$TEMPORAL_SOURCE_SHA256" "$tmp_dir/$temporal_source" | sha256sum --check
tar -xzf "$tmp_dir/$temporal_source" -C "$tmp_dir"
sudo rm -rf -- /opt/temporal/schema/postgresql
sudo install -d -m 0755 /opt/temporal/schema/postgresql
sudo cp -a \
  "$tmp_dir/temporal-${TEMPORAL_VERSION}/schema/postgresql/v12" \
  /opt/temporal/schema/postgresql/

log "Installing checksummed Temporal CLI $TEMPORAL_CLI_VERSION"
temporal_cli_archive="temporal_cli_${TEMPORAL_CLI_VERSION}_linux_amd64.tar.gz"
curl -fsSL \
  "https://github.com/temporalio/cli/releases/download/v${TEMPORAL_CLI_VERSION}/${temporal_cli_archive}" \
  -o "$tmp_dir/$temporal_cli_archive"
printf '%s  %s\n' "$TEMPORAL_CLI_LINUX_AMD64_SHA256" "$tmp_dir/$temporal_cli_archive" | sha256sum --check
mkdir -p "$tmp_dir/temporal-cli"
tar -xzf "$tmp_dir/$temporal_cli_archive" -C "$tmp_dir/temporal-cli" temporal
sudo install -m 0755 "$tmp_dir/temporal-cli/temporal" /usr/local/bin/temporal

if ! id echo-analytics >/dev/null 2>&1; then
  sudo useradd --system --home-dir /var/lib/echo-analytics --shell /usr/sbin/nologin echo-analytics
fi
sudo install -d -m 0750 -o root -g echo-analytics /etc/echo-analytics
sudo install -d -m 0750 -o echo-analytics -g echo-analytics \
  /var/lib/echo-analytics \
  /var/lib/echo-analytics/minio \
  /var/log/echo-analytics

sudo systemctl enable postgresql clickhouse-server
log "Runtime packages installed; install artifacts before configuring services"
