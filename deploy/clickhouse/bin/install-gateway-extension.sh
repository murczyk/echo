#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_versions
[[ $EUID == 0 ]] || die "run as root"
for command in python3 sha256sum pg_ctlcluster pg_lsclusters systemctl runuser; do
  require_cmd "$command"
done

library=/usr/lib/postgresql/$POSTGRESQL_MAJOR/lib/pg_clickhouse.so
work_dir=$(mktemp -d)
stopped=false
installed=false
declare -a active_timers=()
backup_dir=""

replace_library() {
  install -o root -g root -m 0755 "$1" "$library.next"
  mv -f "$library.next" "$library"
}

finish() {
  local status=$?
  trap - EXIT
  if ((status != 0)) && $stopped; then
    log "Installation failed; restoring saved gateway library"
    pg_ctlcluster --mode fast "$POSTGRESQL_MAJOR" main stop || true
    if $installed; then
      replace_library "$backup_dir/pg_clickhouse.so"
      [[ $(sha256sum "$library" | awk '{print $1}') == "$(cat "$backup_dir/library.sha256")" ]] \
        || status=1
    fi
    pg_ctlcluster "$POSTGRESQL_MAJOR" main start || status=1
  fi
  for timer in "${active_timers[@]}"; do
    systemctl start "$timer" || status=1
  done
  rm -rf -- "$work_dir"
  exit "$status"
}
trap finish EXIT

if [[ ${1:-} == --rollback ]]; then
  backup_dir=${2:?usage: install-gateway-extension.sh --rollback BACKUP_DIRECTORY}
  require_file "$backup_dir/pg_clickhouse.so"
  expected_sha=$(cat "$backup_dir/library.sha256")
  candidate=$backup_dir/pg_clickhouse.so
else
  artifact=${1:?usage: install-gateway-extension.sh ARTIFACT SHA256 BACKUP_DIRECTORY}
  archive_sha=${2:?archive SHA256 is required}
  backup_dir=${3:?backup directory is required}
  [[ "$archive_sha" =~ ^[a-f0-9]{64}$ ]] || die "invalid archive SHA256"
  [[ $(sha256sum "$artifact" | awk '{print $1}') == "$archive_sha" ]] || die "artifact checksum mismatch"
  [[ ! -e "$backup_dir" ]] || die "backup directory already exists"
  python3 - "$artifact" "$work_dir" "$PG_CLICKHOUSE_GIT_COMMIT" "$POSTGRESQL_MAJOR" "$PG_CLICKHOUSE_VERSION" <<'PY'
import hashlib, json, pathlib, sys, tarfile
root = pathlib.Path(sys.argv[2])
with tarfile.open(sys.argv[1], "r:gz") as archive:
    members = archive.getmembers()
    assert len(members) == 3 and {m.name for m in members} == {"pg_clickhouse.so", "LICENSE.md", "build-info.json"}
    for member in members:
        assert member.isfile(), "artifact contains a link or special file"
        (root / member.name).write_bytes(archive.extractfile(member).read())
metadata = json.loads((root / "build-info.json").read_text())
assert metadata["commit"] == sys.argv[3] and metadata["postgresql_major"] == int(sys.argv[4])
assert metadata["version"] == sys.argv[5]
assert metadata["library_sha256"] == hashlib.sha256((root / "pg_clickhouse.so").read_bytes()).hexdigest()
PY
  candidate=$work_dir/pg_clickhouse.so
  expected_sha=$(sha256sum "$candidate" | awk '{print $1}')
fi
[[ "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || die "invalid library SHA256"
[[ $(sha256sum "$candidate" | awk '{print $1}') == "$expected_sha" ]] || die "library checksum mismatch"
[[ -f "$library" ]] || die "gateway extension is not installed"
[[ $(pg_lsclusters --no-header "$POSTGRESQL_MAJOR" main | awk '{print $4}') == online ]] \
  || die "gateway cluster must be healthy before replacement"
acquire_analytics_reconcile_lock

if [[ ${1:-} != --rollback ]]; then
  install -d -o root -g root -m 0700 "$backup_dir"
  cp -a "$library" "$backup_dir/pg_clickhouse.so"
  sha256sum "$library" | awk '{print $1}' > "$backup_dir/library.sha256"
  cp "$work_dir/build-info.json" "$backup_dir/new-build-info.json"
  find /etc/echo-analytics "/etc/postgresql/$POSTGRESQL_MAJOR/main" -type f -exec sha256sum {} + \
    | sort > "$backup_dir/config.sha256"
fi
for timer in echo-analytics-reconcile.timer echo-analytics-health.timer; do
  if systemctl is-active --quiet "$timer"; then
    active_timers+=("$timer")
    systemctl stop "$timer"
  fi
done
stopped=true
pg_ctlcluster --mode fast "$POSTGRESQL_MAJOR" main stop
[[ $(pg_lsclusters --no-header "$POSTGRESQL_MAJOR" main | awk '{print $4}') == down ]] \
  || die "gateway did not stop"
installed=true
replace_library "$candidate"
[[ $(sha256sum "$library" | awk '{print $1}') == "$expected_sha" ]] || die "installed checksum mismatch"
pg_ctlcluster "$POSTGRESQL_MAJOR" main start
runuser -u postgres -- "/usr/lib/postgresql/$POSTGRESQL_MAJOR/bin/psql" \
  -XqAt -v ON_ERROR_STOP=1 -d echo_analytics_gateway \
  -c "SET statement_timeout='15s'; SELECT pgch_version(); SELECT 1 FROM signal_message WHERE id BETWEEN 1 AND 10 LIMIT 1;"
sha256sum --check "$backup_dir/config.sha256" >/dev/null
stopped=false
log "Gateway library verified: $expected_sha; rollback: $backup_dir"
