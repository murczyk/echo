#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
CLICKHOUSE_DIR=$SCRIPT_DIR/clickhouse
SOURCE_CONFIG_FILE=${ECHO_PEERDB_SOURCE_CONFIG_FILE:-/etc/echo-peerdb/source.env}
ANALYTICS_DEPLOY_DIR=/opt/echo-analytics/deploy
assume_yes=false
dry_run=false
dump_file=
analytics_enabled=false
analytics_ssh_target=
table_reconcile_timer_should_start=false
preserve_local_ai_agent_profile=true
local_ai_agent_profile_file=
local_ai_agent_profile_retry=true

usage() {
  cat <<'EOF'
Usage: deploy/restore-copied-db.sh [--yes] [--dry-run]
                                  [--no-preserve-local-ai-agent-profile] DUMP_FILE

Replace the local wd database from a copy-db archive. If the source-side
PeerDB configuration exists, pause and resync the paired analytics stack too.
By default, retain the local AI-agent dispatcher, proxy, and engine settings
while discarding copied AI-agent runtime state.
EOF
}

restore_log() {
  printf '[restore-copied-db] %s\n' "$*"
}

restore_die() {
  printf '[restore-copied-db] ERROR: %s\n' "$*" >&2
  exit 1
}

parse_args() {
  while (($#)); do
    case "$1" in
      --yes)
        assume_yes=true
        ;;
      --dry-run)
        dry_run=true
        ;;
      --no-preserve-local-ai-agent-profile)
        preserve_local_ai_agent_profile=false
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      -* )
        restore_die "unknown option: $1"
        ;;
      *)
        [[ -z "$dump_file" ]] \
          || restore_die "only one dump file may be supplied"
        dump_file=$1
        ;;
    esac
    shift
  done
  [[ -n "$dump_file" ]] || restore_die "DUMP_FILE is required"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 \
    || restore_die "missing command: $1"
}

confirm_restore() {
  $assume_yes && return
  $dry_run && return
  [[ -t 0 ]] \
    || restore_die "confirmation requires a terminal; rerun with --yes"
  printf 'Replace local database wd from %s? [y/N] ' "$dump_file"
  read -r reply
  [[ "$reply" == y || "$reply" == Y ]] || restore_die "restore cancelled"
}

validate_dump_migrations() {
  local version
  local -a unknown_versions=()

  while IFS= read -r version; do
    [[ -n "$version" ]] || continue
    [[ "$version" =~ ^m[0-9]{8}_[0-9]{6}_[a-z0-9_]+$ \
      && -f "$REPO_DIR/echo-migration/src/$version.rs" ]] \
      || unknown_versions+=("$version")
  done < <(
    pg_restore --data-only --table=seaql_migrations --file=- "$dump_file" \
      | awk '
          /^COPY .*seaql_migrations / { copying = 1; next }
          copying && $0 == "\\." { exit }
          copying { print $1 }
        '
  )

  ((${#unknown_versions[@]} == 0)) && return
  printf '[restore-copied-db] ERROR: dump contains migrations missing from this checkout:\n' >&2
  printf '  %s\n' "${unknown_versions[@]}" >&2
  restore_die "update the checkout before replacing wd"
}

load_optional_analytics() {
  if [[ ! -f "$SOURCE_CONFIG_FILE" ]] \
    && ! sudo -n test -f "$SOURCE_CONFIG_FILE" 2>/dev/null; then
    restore_log \
      "PeerDB source configuration is absent; using PostgreSQL-only restore"
    return
  fi

  # shellcheck source=clickhouse/bin/lib.sh
  source "$CLICKHOUSE_DIR/bin/lib.sh"
  load_source_config
  require_command ssh
  require_command systemctl
  require_command timeout
  analytics_enabled=true
  analytics_ssh_target=${ANALYTICS_SSH_TARGET:-echo@${ANALYTICS_ADDRESS%/*}}
  [[ "$SOURCE_DB" == wd ]] \
    || restore_die "copy-db restore supports SOURCE_DB=wd, found $SOURCE_DB"
  [[ "$analytics_ssh_target" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ ]] \
    || restore_die "invalid ANALYTICS_SSH_TARGET: $analytics_ssh_target"
  restore_log \
    "PeerDB source configuration found; analytics target is $analytics_ssh_target"
}

resume_table_reconcile_timer() {
  local status=$?
  trap - EXIT
  if $table_reconcile_timer_should_start && ! $dry_run; then
    sudo systemctl start echo-peerdb-table-reconcile.timer \
      || restore_log "WARNING: could not restart automatic table reconciliation"
  fi
  cleanup_local_ai_agent_profile
  exit "$status"
}

cleanup_local_ai_agent_profile() {
  [[ -n "$local_ai_agent_profile_file" ]] || return
  [[ -f "$local_ai_agent_profile_file" ]] || return
  if $local_ai_agent_profile_retry; then
    restore_log \
      "Local AI-agent profile retained for retry: $local_ai_agent_profile_file"
    return
  fi
  rm -f -- "$local_ai_agent_profile_file"
}

snapshot_local_ai_agent_profile() {
  if ! $preserve_local_ai_agent_profile; then
    restore_log "Local AI-agent profile preservation was disabled"
    return
  fi
  if $dry_run; then
    restore_log "Would snapshot the local AI-agent profile"
    return
  fi

  require_command mktemp
  local_ai_agent_profile_file=$(mktemp /var/tmp/echo-local-ai-agent-profile.XXXXXX)
  chmod 600 "$local_ai_agent_profile_file"
  restore_log "Snapshotting local AI-agent profile"
  (
    cd "$REPO_DIR"
    cargo run -p wdintel-rs -- --mode=debug \
      oneoff-export-local-ai-agent-profile \
      --output "$local_ai_agent_profile_file"
  )
  if [[ ! -s "$local_ai_agent_profile_file" ]]; then
    rm -f -- "$local_ai_agent_profile_file"
    local_ai_agent_profile_file=
    restore_log "No local AI-agent profile is configured; continuing"
  fi
}

restore_local_ai_agent_profile() {
  [[ -n "$local_ai_agent_profile_file" ]] || return
  if $dry_run; then
    restore_log "Would restore and validate the local AI-agent profile"
    return
  fi

  restore_log "Restoring and validating local AI-agent profile"
  (
    cd "$REPO_DIR"
    cargo run -p wdintel-rs -- --mode=debug \
      oneoff-import-local-ai-agent-profile \
      --input "$local_ai_agent_profile_file"
  )
  rm -f -- "$local_ai_agent_profile_file"
  local_ai_agent_profile_file=
  local_ai_agent_profile_retry=false
}

pause_table_reconcile_timer() {
  if ! $analytics_enabled; then
    return 0
  fi
  if $dry_run; then
    restore_log "Would pause automatic table reconciliation"
    return 0
  fi

  if systemctl is-active --quiet echo-peerdb-table-reconcile.timer \
    || systemctl is-enabled --quiet echo-peerdb-table-reconcile.timer; then
    table_reconcile_timer_should_start=true
  fi
  trap resume_table_reconcile_timer EXIT
  sudo systemctl stop echo-peerdb-table-reconcile.timer 2>/dev/null || true
  acquire_source_reconcile_lock
}

run_remote_analytics_command() {
  local command=$1
  ssh -n \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    "$analytics_ssh_target" \
    "cd '$ANALYTICS_DEPLOY_DIR' && $command"
}

preflight_analytics() {
  if ! $analytics_enabled; then
    return 0
  fi
  if $dry_run; then
    restore_log "Would verify analytics SSH and recovery scripts"
    return
  fi

  restore_log "Verifying analytics SSH and recovery scripts"
  timeout --foreground 30s \
    ssh -n \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      "$analytics_ssh_target" \
      "cd '$ANALYTICS_DEPLOY_DIR' &&
       test -x bin/stop.sh &&
       test -x bin/start.sh &&
       test -x bin/04-bootstrap-mirror.sh &&
       test -x bin/resync.sh &&
       test -x bin/finish-resync.sh" \
    || restore_die \
      "analytics SSH or recovery scripts are unavailable on $analytics_ssh_target"
}

stop_analytics() {
  if ! $analytics_enabled; then
    return 0
  fi
  if $dry_run; then
    restore_log "Would stop analytics on $analytics_ssh_target"
    return
  fi
  restore_log "Stopping analytics before replacing its source database"
  run_remote_analytics_command "bin/stop.sh"
}

wait_for_inactive_logical_slots() {
  local active_slots attempt
  if ! $analytics_enabled; then
    return 0
  fi
  $dry_run && return

  for attempt in {1..30}; do
    active_slots=$(sudo -u postgres psql -X -Atq wd -c \
      "SELECT string_agg(slot_name, ', ' ORDER BY slot_name)
       FROM pg_replication_slots
       WHERE database = 'wd' AND slot_type = 'logical' AND active")
    [[ -z "$active_slots" ]] && return
    sleep 1
  done
  restore_die "logical replication slots are still active: $active_slots"
}

restore_database() {
  if $dry_run; then
    restore_log "Would drop, recreate, and restore database wd"
    return
  fi

  restore_log "Replacing PostgreSQL database wd"
  sudo -u postgres dropdb --force wd
  sudo -u postgres createdb wd
  sudo -u postgres pg_restore -d wd "$dump_file"
}

run_migrations() {
  if $dry_run; then
    restore_log "Would run current Echo and echo-im migrations"
    return
  fi
  restore_log "Running current Echo and echo-im migrations"
  (cd "$REPO_DIR" && cargo run -p wdintel-rs -- --mode=debug migrate)
}

reconfigure_analytics_source() {
  if ! $analytics_enabled; then
    return 0
  fi
  if $dry_run; then
    restore_log "Would recreate PeerDB source grants and publication"
    return
  fi
  restore_log "Recreating PeerDB source grants and publication"
  "$CLICKHOUSE_DIR/bin/source-configure.sh" --yes
  table_reconcile_timer_should_start=true
  sudo systemctl stop echo-peerdb-table-reconcile.timer
}

start_and_resync_analytics() {
  if ! $analytics_enabled; then
    return 0
  fi
  if $dry_run; then
    restore_log \
      "Would start, resync, refresh, and health-check analytics on $analytics_ssh_target"
    return
  fi
  restore_log "Starting analytics and rebuilding its ClickHouse mirror"
  run_remote_analytics_command \
    "bin/start.sh && bin/04-bootstrap-mirror.sh && bin/resync.sh --yes && bin/finish-resync.sh"
  restore_log "Analytics resync completed and passed its end-to-end health check"
}

main() {
  parse_args "$@"
  require_command cargo
  require_command pg_restore
  require_command sudo
  [[ -r "$dump_file" ]] \
    || restore_die "dump is missing or unreadable: $dump_file"
  pg_restore --list "$dump_file" >/dev/null \
    || restore_die \
      "dump is not a readable PostgreSQL custom archive: $dump_file"
  validate_dump_migrations
  load_optional_analytics
  preflight_analytics
  confirm_restore
  snapshot_local_ai_agent_profile
  trap cleanup_local_ai_agent_profile EXIT
  pause_table_reconcile_timer
  stop_analytics
  wait_for_inactive_logical_slots
  restore_database
  run_migrations
  restore_local_ai_agent_profile
  reconfigure_analytics_source
  start_and_resync_analytics
  restore_log "Database restore completed"
}

main "$@"
