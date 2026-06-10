#!/usr/bin/env bash
set -euo pipefail

STANZA="${1:-}"
if [[ -z "${STANZA}" ]]; then
  echo "usage: $0 <stanza>" >&2
  exit 2
fi

PG_VERSION="${ECHO_PGBACKREST_RESTORE_PG_VERSION:-14}"
PG_CLUSTER="${ECHO_PGBACKREST_RESTORE_PG_CLUSTER:-main}"
PGDATA="${ECHO_PGBACKREST_RESTORE_PGDATA:-/var/lib/postgresql/${PG_VERSION}/${PG_CLUSTER}}"
PGDATA_NEXT="${ECHO_PGBACKREST_RESTORE_PGDATA_NEXT:-${PGDATA}.next}"
PGDATA_PREV="${ECHO_PGBACKREST_RESTORE_PGDATA_PREV:-${PGDATA}.prev}"
PGBACKREST_CONF="${ECHO_PGBACKREST_CONF:-/etc/pgbackrest/pgbackrest.conf}"
PGBACKREST_CONF_INCLUDE="${ECHO_PGBACKREST_CONF_INCLUDE:-/etc/pgbackrest/conf.d}"
PGBACKREST_LOG_LEVEL="${ECHO_PGBACKREST_RESTORE_LOG_LEVEL:-info}"
PGBACKREST_IO_TIMEOUT="${ECHO_PGBACKREST_RESTORE_IO_TIMEOUT:-10m}"
PGBACKREST_PROCESS_MAX="${ECHO_PGBACKREST_RESTORE_PROCESS_MAX:-1}"
PGBACKREST_BIN="${ECHO_PGBACKREST_BIN:-/usr/bin/pgbackrest}"
PG_CTLCLUSTER_BIN="${ECHO_PG_CTLCLUSTER_BIN:-/usr/bin/pg_ctlcluster}"
PG_CONTROLDATA_BIN="${ECHO_PG_CONTROLDATA_BIN:-/usr/lib/postgresql/${PG_VERSION}/bin/pg_controldata}"
LOCK_FILE="/run/pgbackrest-safe-restore-${PG_VERSION}-${PG_CLUSTER}.lock"
REQUIRED_CONF_DIR="/etc/postgresql/${PG_VERSION}/${PG_CLUSTER}/conf.d"
REQUIRED_CONF="${REQUIRED_CONF_DIR}/99-echo-restore-required.conf"
REQUIRED_CONF_BACKUP=""
REQUIRED_CONF_WAS_PRESENT="false"
PGDATA_MOVED_TO_PREV="false"

log() {
  printf '%s %s\n' "$(date -Iseconds)" "$*"
}

need_exe() {
  if [[ ! -x "$1" ]]; then
    echo "missing executable: $1" >&2
    exit 2
  fi
}

check_paths() {
  case "${PGDATA}" in
    /var/lib/postgresql/*/*) ;;
    *)
      echo "refusing unexpected PGDATA path: ${PGDATA}" >&2
      exit 2
      ;;
  esac
  if [[ "${PGDATA_NEXT}" == "${PGDATA}" || "${PGDATA_PREV}" == "${PGDATA}" || "${PGDATA_NEXT}" == "${PGDATA_PREV}" ]]; then
    echo "refusing overlapping pgdata paths" >&2
    exit 2
  fi
}

cluster_is_running() {
  "${PG_CTLCLUSTER_BIN}" "${PG_VERSION}" "${PG_CLUSTER}" status >/dev/null 2>&1
}

start_cluster_if_possible() {
  if [[ ! -s "${PGDATA}/global/pg_control" ]]; then
    log "not starting PostgreSQL; ${PGDATA}/global/pg_control is missing"
    return 1
  fi
  if cluster_is_running; then
    log "PostgreSQL ${PG_VERSION}/${PG_CLUSTER} is already running"
    return 0
  fi
  systemctl reset-failed "postgresql@${PG_VERSION}-${PG_CLUSTER}.service" >/dev/null 2>&1 || true
  "${PG_CTLCLUSTER_BIN}" "${PG_VERSION}" "${PG_CLUSTER}" start
}

stop_cluster() {
  local rc
  set +e
  "${PG_CTLCLUSTER_BIN}" "${PG_VERSION}" "${PG_CLUSTER}" stop
  rc="$?"
  set -e
  if [[ "${rc}" -ne 0 && "${rc}" -ne 2 ]]; then
    return "${rc}"
  fi
}

restore_into_next() {
  rm -rf --one-file-system "${PGDATA_NEXT}" || return
  install -d -m 0700 -o postgres -g postgres "${PGDATA_NEXT}" || return
  log "restoring ${STANZA} into ${PGDATA_NEXT}"
  sudo -n -u postgres "${PGBACKREST_BIN}" \
    --config="${PGBACKREST_CONF}" \
    --config-include-path="${PGBACKREST_CONF_INCLUDE}" \
    --stanza="${STANZA}" \
    --pg1-path="${PGDATA_NEXT}" \
    --delta \
    --io-timeout="${PGBACKREST_IO_TIMEOUT}" \
    --process-max="${PGBACKREST_PROCESS_MAX}" \
    --log-level-console="${PGBACKREST_LOG_LEVEL}" \
    restore || return
  "${PG_CONTROLDATA_BIN}" "${PGDATA_NEXT}" >/dev/null || return
}

write_required_postgres_settings() {
  local ctl req_max_connections req_max_worker_processes req_max_wal_senders
  local req_max_prepared_xacts req_max_locks_per_xact tmp

  ctl="$("${PG_CONTROLDATA_BIN}" "${PGDATA_NEXT}")" || return
  req_max_connections="$(printf '%s\n' "${ctl}" | sed -nE 's/^max_connections setting:[[:space:]]*([0-9]+).*/\1/p' | head -n 1 || true)"
  req_max_worker_processes="$(printf '%s\n' "${ctl}" | sed -nE 's/^max_worker_processes setting:[[:space:]]*([0-9]+).*/\1/p' | head -n 1 || true)"
  req_max_wal_senders="$(printf '%s\n' "${ctl}" | sed -nE 's/^max_wal_senders setting:[[:space:]]*([0-9]+).*/\1/p' | head -n 1 || true)"
  req_max_prepared_xacts="$(printf '%s\n' "${ctl}" | sed -nE 's/^max_prepared_xacts setting:[[:space:]]*([0-9]+).*/\1/p' | head -n 1 || true)"
  req_max_locks_per_xact="$(printf '%s\n' "${ctl}" | sed -nE 's/^max_locks_per_xact setting:[[:space:]]*([0-9]+).*/\1/p' | head -n 1 || true)"

  install -d -m 0755 "${REQUIRED_CONF_DIR}" || return
  tmp="$(mktemp)" || return
  cat > "${tmp}" <<EOF || return
# Managed by pgbackrest-safe-restore. Derived from pg_control of the restored cluster.
max_connections = ${req_max_connections:-100}
max_worker_processes = ${req_max_worker_processes:-8}
max_wal_senders = ${req_max_wal_senders:-10}
max_prepared_transactions = ${req_max_prepared_xacts:-0}
max_locks_per_transaction = ${req_max_locks_per_xact:-64}
EOF
  install -m 0644 -o root -g root "${tmp}" "${REQUIRED_CONF}" || {
    rm -f "${tmp}"
    return 1
  }
  rm -f "${tmp}" || return
}

save_required_postgres_settings() {
  install -d -m 0755 "${REQUIRED_CONF_DIR}" || return
  REQUIRED_CONF_BACKUP="$(mktemp)" || return
  if [[ -f "${REQUIRED_CONF}" ]]; then
    cp -a "${REQUIRED_CONF}" "${REQUIRED_CONF_BACKUP}" || return
    REQUIRED_CONF_WAS_PRESENT="true"
  else
    REQUIRED_CONF_WAS_PRESENT="false"
  fi
}

restore_required_postgres_settings() {
  if [[ -z "${REQUIRED_CONF_BACKUP}" ]]; then
    return 0
  fi
  if [[ "${REQUIRED_CONF_WAS_PRESENT}" == "true" ]]; then
    install -m 0644 -o root -g root "${REQUIRED_CONF_BACKUP}" "${REQUIRED_CONF}"
  else
    rm -f "${REQUIRED_CONF}"
  fi
  rm -f "${REQUIRED_CONF_BACKUP}"
  REQUIRED_CONF_BACKUP=""
}

discard_required_postgres_settings_backup() {
  if [[ -n "${REQUIRED_CONF_BACKUP}" ]]; then
    rm -f "${REQUIRED_CONF_BACKUP}"
    REQUIRED_CONF_BACKUP=""
  fi
}

swap_pgdata() {
  PGDATA_MOVED_TO_PREV="false"
  rm -rf --one-file-system "${PGDATA_PREV}" || return
  if [[ -e "${PGDATA}" ]]; then
    mv "${PGDATA}" "${PGDATA_PREV}" || return
    PGDATA_MOVED_TO_PREV="true"
  fi
  mv "${PGDATA_NEXT}" "${PGDATA}" || return
}

rollback_pgdata() {
  log "rolling back to previous PostgreSQL data directory"
  stop_cluster || true
  if [[ "${PGDATA_MOVED_TO_PREV}" == "true" && -d "${PGDATA_PREV}" ]]; then
    rm -rf --one-file-system "${PGDATA}"
    mv "${PGDATA_PREV}" "${PGDATA}"
  elif [[ "${PGDATA_MOVED_TO_PREV}" != "true" ]]; then
    log "previous PostgreSQL data directory was not moved; leaving ${PGDATA} unchanged"
  else
    log "previous PostgreSQL data directory is missing; leaving ${PGDATA} unchanged"
  fi
  restore_required_postgres_settings
  start_cluster_if_possible || true
}

main() {
  need_exe "${PGBACKREST_BIN}"
  need_exe "${PG_CTLCLUSTER_BIN}"
  need_exe "${PG_CONTROLDATA_BIN}"
  check_paths

  exec 9>"${LOCK_FILE}"
  if ! flock -n 9; then
    echo "another pgBackRest restore is already running" >&2
    exit 1
  fi

  if ! restore_into_next; then
    log "staged restore failed; leaving ${PGDATA} unchanged"
    rm -rf --one-file-system "${PGDATA_NEXT}"
    start_cluster_if_possible || true
    exit 1
  fi
  if ! save_required_postgres_settings; then
    log "failed to save existing PostgreSQL restore-required settings; leaving ${PGDATA} unchanged"
    rm -rf --one-file-system "${PGDATA_NEXT}"
    start_cluster_if_possible || true
    exit 1
  fi
  if ! write_required_postgres_settings; then
    log "restored cluster validation failed; leaving ${PGDATA} unchanged"
    rm -rf --one-file-system "${PGDATA_NEXT}"
    restore_required_postgres_settings
    start_cluster_if_possible || true
    exit 1
  fi

  log "stopping PostgreSQL for final data directory swap"
  if ! stop_cluster; then
    log "failed to stop PostgreSQL; leaving ${PGDATA} unchanged"
    restore_required_postgres_settings
    start_cluster_if_possible || true
    exit 1
  fi
  if ! swap_pgdata; then
    rollback_pgdata
    exit 1
  fi

  log "starting PostgreSQL with restored data directory"
  if ! start_cluster_if_possible; then
    rollback_pgdata
    exit 1
  fi

  discard_required_postgres_settings_backup
  rm -rf --one-file-system "${PGDATA_PREV}"
  log "pgBackRest restore completed successfully"
}

main "$@"
