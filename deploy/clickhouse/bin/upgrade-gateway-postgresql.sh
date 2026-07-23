#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_versions

old_major=${1:-}
start_new=true
confirmed=false
for argument in "${@:2}"; do
  case "$argument" in
    --no-start)
      start_new=false
      ;;
    --yes)
      confirmed=true
      ;;
    *)
      die "unknown argument: $argument"
      ;;
  esac
done

[[ "$old_major" =~ ^[0-9]+$ ]] \
  || die "usage: $0 <old-major> [--no-start] --yes"
((POSTGRESQL_MAJOR > old_major)) \
  || die "target PostgreSQL $POSTGRESQL_MAJOR must be newer than $old_major"
$confirmed || die "major upgrade requires --yes"

for command in gzip pg_conftool pg_ctlcluster pg_dumpall pg_isready pg_lsclusters pg_upgradecluster sha256sum stat sudo systemctl; do
  require_cmd "$command"
done

old_unit="postgresql@$old_major-main.service"
new_unit="postgresql@$POSTGRESQL_MAJOR-main.service"
old_bindir=/usr/lib/postgresql/$old_major/bin
new_bindir=/usr/lib/postgresql/$POSTGRESQL_MAJOR/bin
old_datadir=/var/lib/postgresql/$old_major/main
pgch_so=/usr/lib/postgresql/$POSTGRESQL_MAJOR/lib/pg_clickhouse.so
pgch_control=/usr/share/postgresql/$POSTGRESQL_MAJOR/extension/pg_clickhouse.control

sudo pg_lsclusters --no-header "$old_major" main >/dev/null 2>&1 \
  || die "missing PostgreSQL cluster: $old_major/main"
if sudo pg_lsclusters --no-header "$POSTGRESQL_MAJOR" main >/dev/null 2>&1; then
  die "target cluster $POSTGRESQL_MAJOR/main already exists; inspect it instead of deleting it automatically"
fi
[[ -x "$old_bindir/pg_controldata" ]] || die "missing old PostgreSQL binaries"
[[ -x "$new_bindir/pg_dumpall" ]] || die "missing PostgreSQL $POSTGRESQL_MAJOR server tools"
[[ -f "$pgch_so" && -f "$pgch_control" ]] \
  || die "pg_clickhouse is not installed for PostgreSQL $POSTGRESQL_MAJOR"
[[ $(stat -c '%U:%G' "$pgch_so") == root:root ]] \
  || die "pg_clickhouse library is not root-owned: $pgch_so"
if [[ $(systemctl is-enabled "$old_unit" 2>/dev/null || true) == masked ]]; then
  die "$old_unit is masked; unmask it for the upgrade and mask the retained cluster again afterward"
fi

log "Checking PostgreSQL $old_major to $POSTGRESQL_MAJOR upgrade prerequisites"
sudo pg_upgradecluster --check -v "$POSTGRESQL_MAJOR" "$old_major" main

old_port=$(sudo pg_lsclusters --no-header "$old_major" main | awk '{ print $3 }')
[[ "$old_port" =~ ^[0-9]+$ ]] || die "could not read the old cluster port"

log "Stopping analytics writers before backing up PostgreSQL $old_major/main"
for unit in echo-analytics-health.timer echo-analytics.target; do
  if systemctl cat "$unit" >/dev/null 2>&1; then
    sudo systemctl stop "$unit"
  fi
done
sudo pg_ctlcluster "$old_major" main start || true
sudo -u postgres "$new_bindir/pg_isready" \
  --host /var/run/postgresql --port "$old_port" --timeout 10 >/dev/null \
  || die "PostgreSQL $old_major/main did not become ready"

backup_timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir=/var/backups/echo-analytics/postgresql-$old_major-$backup_timestamp
backup_file=$backup_dir/cluster.sql.gz
sudo install -d -o root -g root -m 0700 "$backup_dir"
sudo install -o root -g root -m 0600 /dev/null "$backup_file"
log "Writing a root-only logical backup to $backup_file"
sudo -u postgres "$new_bindir/pg_dumpall" \
  --host /var/run/postgresql \
  --port "$old_port" \
  | gzip -9 \
  | sudo tee "$backup_file" >/dev/null
sudo cp -a "/etc/postgresql/$old_major/main" "$backup_dir/config"
sudo sha256sum "$backup_file" | sudo tee "$backup_dir/SHA256SUMS" >/dev/null
sudo chmod 0600 "$backup_dir/SHA256SUMS"
sudo gzip --test "$backup_file"

sudo -u postgres "$new_bindir/psql" -X \
  --host /var/run/postgresql --port "$old_port" --dbname postgres \
  -v ON_ERROR_STOP=1 -c CHECKPOINT >/dev/null
sudo pg_ctlcluster --mode fast "$old_major" main stop
cluster_state=$(sudo env LC_ALL=C "$old_bindir/pg_controldata" "$old_datadir" \
  | awk -F: '/Database cluster state/ { sub(/^[[:space:]]+/, "", $2); print $2 }')
[[ "$cluster_state" == "shut down" ]] \
  || die "old cluster is not cleanly shut down: $cluster_state"

upgrade_arguments=(-v "$POSTGRESQL_MAJOR" --method=dump)
$start_new || upgrade_arguments+=(--no-start)
log "Upgrading PostgreSQL $old_major/main to $POSTGRESQL_MAJOR/main"
sudo pg_upgradecluster "${upgrade_arguments[@]}" "$old_major" main

new_port=$(sudo pg_lsclusters --no-header "$POSTGRESQL_MAJOR" main | awk '{ print $3 }')
[[ "$new_port" == "$old_port" ]] \
  || die "upgraded cluster uses unexpected port $new_port instead of $old_port"
old_start_mode=$(sudo awk 'NF && $1 !~ /^#/ { print $1; exit }' \
  "/etc/postgresql/$old_major/main/start.conf")
[[ "$old_start_mode" == manual ]] \
  || die "retained PostgreSQL $old_major cluster is not in manual startup mode"

if $start_new; then
  sudo systemctl start "$new_unit"
  sudo -u postgres "$new_bindir/pg_isready" \
    --host /var/run/postgresql --port "$new_port" --timeout 10 >/dev/null \
    || die "upgraded PostgreSQL $POSTGRESQL_MAJOR/main did not become ready"
  actual_major=$(sudo -u postgres "$new_bindir/psql" -XAtq \
    --host /var/run/postgresql --port "$new_port" --dbname postgres \
    -c "SELECT current_setting('server_version_num')::integer / 10000")
  [[ "$actual_major" == "$POSTGRESQL_MAJOR" ]] \
    || die "upgraded cluster reports unexpected major: $actual_major"
fi

log "Upgrade complete; PostgreSQL $old_major/main is retained offline for rollback"
log "Backup: $backup_file"
