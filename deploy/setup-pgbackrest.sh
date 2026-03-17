#!/usr/bin/env bash
set -euo pipefail

SERVER=""
BACKUP_NAME=""
LEGACY_TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)
      SERVER="${2:-}"
      shift 2
      ;;
    --backup-name)
      BACKUP_NAME="${2:-}"
      shift 2
      ;;
    --target)
      LEGACY_TARGET="${2:-}"
      shift 2
      ;;
    --help|-h)
      echo "usage: $0 --server <ssh-host> [--backup-name <backup-name>]" >&2
      echo "" >&2
      echo "legacy usage: $0 --server <backup-name> --target <ssh-host>" >&2
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "usage: $0 --server <ssh-host> [--backup-name <backup-name>]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${SERVER}" ]]; then
  echo "missing required argument: --server <ssh-host>" >&2
  exit 2
fi

if [[ -n "${LEGACY_TARGET}" ]]; then
  if [[ -n "${BACKUP_NAME}" ]]; then
    echo "invalid args: don't use legacy --target together with --backup-name" >&2
    exit 2
  fi
  # Legacy calling convention: --server=<backup-name> --target=<ssh-host>.
  BACKUP_NAME="${SERVER}"
  SERVER="${LEGACY_TARGET}"
  LEGACY_TARGET=""
fi

if [[ -z "${BACKUP_NAME}" ]]; then
  BACKUP_NAME="${SERVER}"
fi

need_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing command: $cmd" >&2
    exit 2
  fi
}

need_cmd ssh
need_cmd sed
need_cmd awk

ECHO_INSTALL_UTILS_BIN="${ECHO_INSTALL_UTILS_BIN:-echo-install-utils}"

echo "==> [server=${SERVER} backup-name=${BACKUP_NAME}] ensure pgdg apt repo + pgbackrest package"
ssh "${SERVER}" "sudo echo-install-utils install-pgbackrest"

echo "==> [server=${SERVER} backup-name=${BACKUP_NAME}] ensure /etc/pgbackrest/pgbackrest.conf base config"
ssh "${SERVER}" "sudo bash -s" <<'REMOTE'
set -euo pipefail

# See note below in this script: pgBackRest reads pgbackrest.conf and also conf.d/*.conf.
if [[ -L /etc/pgbackrest/pgbackrest.conf ]]; then
  rm -f /etc/pgbackrest/pgbackrest.conf
fi

install -d -m 0755 /etc/pgbackrest

tmp="$(mktemp)"
cat > "${tmp}" <<'EOF'
# Managed by echo deploy scripts.
# Stanza configs are installed under /etc/pgbackrest/conf.d/*.conf.
EOF
chmod 0644 "${tmp}"
chown root:root "${tmp}"

if cmp -s "${tmp}" /etc/pgbackrest/pgbackrest.conf 2>/dev/null; then
  rm -f "${tmp}"
else
  install -m 0644 -o root -g root "${tmp}" /etc/pgbackrest/pgbackrest.conf
  rm -f "${tmp}"
fi
REMOTE

STANZA=""
if [[ "${SERVER}" == "${BACKUP_NAME}" ]]; then
  echo "==> [server=${SERVER} backup-name=${BACKUP_NAME}] detect pgBackRest stanza (existing config)"
  STANZA="$(
    ssh "${SERVER}" "sudo bash -s" <<'REMOTE'
set -euo pipefail

stanza=""

pg_conf=/etc/postgresql/14/main/conf.d/90-pgbackrest.conf
if [[ -f "${pg_conf}" ]]; then
  stanza="$(
    sed -nE "s/^[[:space:]]*archive_command[[:space:]]*=[[:space:]]*'.*--stanza=([^[:space:]']+).*'$/\\1/p" "${pg_conf}" \
      | head -n 1 || true
  )"
fi

if [[ -z "${stanza}" ]]; then
  shopt -s nullglob
  files=(/etc/pgbackrest/conf.d/pgbackrest-*.conf)
  if [[ "${#files[@]}" -eq 1 ]]; then
    stanza="$(
      awk '
        {
          line=$0
          sub(/^[[:space:]]+/, "", line)
          sub(/[[:space:]]+$/, "", line)
          if (line ~ /^\[/ && line ~ /\]$/) {
            s = substr(line, 2, length(line) - 2)
            if (s !~ /^global(:|$)/) { print s; exit }
          }
        }
      ' "${files[0]}" || true
    )"
  fi
fi

	if [[ -n "${stanza}" ]]; then
	  printf '%s' "${stanza}"
	fi
REMOTE
  )"
fi

if [[ -z "${STANZA}" ]]; then
  if [[ "${BACKUP_NAME}" == wd-* ]]; then
    STANZA="${BACKUP_NAME}"
  else
    STANZA="wd-${BACKUP_NAME}"
  fi
fi

echo "stanza=${STANZA}"

BW_NOTE="echo-pgbackrest-${BACKUP_NAME}"
BW_EXIT_CODE=0

SERVER_PGBR_CONF="/etc/pgbackrest/conf.d/pgbackrest-${STANZA}.conf"

echo "==> [server=${SERVER} backup-name=${BACKUP_NAME}] sync ${SERVER_PGBR_CONF} from Bitwarden"
ssh "${SERVER}" "sudo install -d -m 0755 /etc/pgbackrest/conf.d"
set +e
"${ECHO_INSTALL_UTILS_BIN}" bw-sync "${SERVER}" "${BW_NOTE}" "${SERVER_PGBR_CONF}" --no-restart --exit-code
BW_EXIT_CODE="$?"
set -e
if [[ "${BW_EXIT_CODE}" -ne 0 && "${BW_EXIT_CODE}" -ne 2 ]]; then
  echo "bw-sync failed with exit code ${BW_EXIT_CODE}" >&2
  exit "${BW_EXIT_CODE}"
fi
ssh "${SERVER}" "sudo chown root:root '${SERVER_PGBR_CONF}' && sudo chmod 0644 '${SERVER_PGBR_CONF}'"

if [[ "${SERVER}" == "${BACKUP_NAME}" ]]; then
  TMP_90="/tmp/90-pgbackrest.${BACKUP_NAME}.conf"
  sed -e "s/@STANZA@/${STANZA}/g" "deploy/postgresql/90-pgbackrest.conf.template" > "${TMP_90}"

  echo "==> [server=${SERVER} backup-name=${BACKUP_NAME}] ensure /etc/postgresql/14/main/conf.d/90-pgbackrest.conf"
  CONF_CHANGED="false"
  set +e
  "${ECHO_INSTALL_UTILS_BIN}" ssh-sync-file --take-a --exit-code "${TMP_90}" "${SERVER}:/etc/postgresql/14/main/conf.d/90-pgbackrest.conf"
  RC="$?"
  set -e
  if [[ "${RC}" -eq 2 ]]; then
    CONF_CHANGED="true"
  elif [[ "${RC}" -ne 0 ]]; then
    echo "ssh-sync-file failed with exit code ${RC}" >&2
    exit "${RC}"
  fi

  ssh "${SERVER}" "sudo chown root:root /etc/postgresql/14/main/conf.d/90-pgbackrest.conf && sudo chmod 0644 /etc/postgresql/14/main/conf.d/90-pgbackrest.conf"

  if [[ "${CONF_CHANGED}" == "true" ]]; then
    echo "==> [server=${SERVER} backup-name=${BACKUP_NAME}] postgres config changed, restarting cluster 14/main"
    ssh "${SERVER}" "sudo pg_ctlcluster 14 main restart"
  else
    echo "==> [server=${SERVER} backup-name=${BACKUP_NAME}] postgres config unchanged, restart skipped"
  fi

  echo "==> [server=${SERVER} backup-name=${BACKUP_NAME}] decide pgBackRest next step from local/repo state"
  PGBACKREST_STATE="$(
    ssh "${SERVER}" "sudo bash -s" <<REMOTE
set -euo pipefail

local_system_id=""
if [[ -x /usr/lib/postgresql/14/bin/pg_controldata ]]; then
  local_system_id="\$(
    /usr/lib/postgresql/14/bin/pg_controldata /var/lib/postgresql/14/main 2>/dev/null \
      | sed -nE 's/^Database system identifier:[[:space:]]*([0-9]+).*$/\1/p' \
      | head -n 1 || true
  )"
fi

set +e
repo_info_json="\$(
  sudo -u postgres pgbackrest \
    --config='/etc/pgbackrest/pgbackrest.conf' \
    --config-include-path='/etc/pgbackrest/conf.d' \
    --stanza='${STANZA}' \
    --output=json \
    info 2>/dev/null
)"
repo_info_rc="\$?"
set -e

if [[ "\${repo_info_rc}" -ne 0 ]]; then
  echo "action=create"
  exit 0
fi

repo_system_id="\$(
  printf '%s\n' "\${repo_info_json}" \
    | sed -nE 's/.*"system-id":([0-9]+).*/\1/p' \
    | head -n 1 || true
)"

if [[ -n "\${local_system_id}" && -n "\${repo_system_id}" && "\${local_system_id}" != "\${repo_system_id}" ]]; then
  echo "action=restore-needed"
  echo "local_system_id=\${local_system_id}"
  echo "repo_system_id=\${repo_system_id}"
  exit 0
fi

echo "action=check"
REMOTE
  )"
  PGBACKREST_ACTION="$(
    printf '%s\n' "${PGBACKREST_STATE}" | sed -nE 's/^action=(.*)$/\1/p' | head -n 1
  )"
  LOCAL_SYSTEM_ID="$(
    printf '%s\n' "${PGBACKREST_STATE}" | sed -nE 's/^local_system_id=(.*)$/\1/p' | head -n 1
  )"
  REPO_SYSTEM_ID="$(
    printf '%s\n' "${PGBACKREST_STATE}" | sed -nE 's/^repo_system_id=(.*)$/\1/p' | head -n 1
  )"

  case "${PGBACKREST_ACTION}" in
    create)
      echo "==> [server=${SERVER} backup-name=${BACKUP_NAME}] repo is empty, creating stanza and running check"
      ssh "${SERVER}" "set -euo pipefail; \
        sudo -u postgres pgbackrest --config='/etc/pgbackrest/pgbackrest.conf' --config-include-path='/etc/pgbackrest/conf.d' --stanza='${STANZA}' --log-level-console=info stanza-create; \
        sudo -u postgres pgbackrest --config='/etc/pgbackrest/pgbackrest.conf' --config-include-path='/etc/pgbackrest/conf.d' --stanza='${STANZA}' --log-level-console=info check"
      ;;
    check)
      echo "==> [server=${SERVER} backup-name=${BACKUP_NAME}] repo matches local cluster, running pgbackrest check"
      ssh "${SERVER}" "set -euo pipefail; \
        sudo -u postgres pgbackrest --config='/etc/pgbackrest/pgbackrest.conf' --config-include-path='/etc/pgbackrest/conf.d' --stanza='${STANZA}' --log-level-console=info check"
      ;;
    restore-needed)
      echo "==> [server=${SERVER} backup-name=${BACKUP_NAME}] existing repo belongs to another cluster"
      echo "    local system id: ${LOCAL_SYSTEM_ID}"
      echo "    repo system id:  ${REPO_SYSTEM_ID}"
      echo "    next action: just restore-pgbackrest --server ${SERVER} --backup-name ${BACKUP_NAME}"
      ;;
    *)
      echo "failed to decide pgBackRest next step on ${SERVER}" >&2
      printf '%s\n' "${PGBACKREST_STATE}" >&2
      exit 1
      ;;
  esac

  rm -f "${TMP_90}"
else
  echo "==> [server=${SERVER} backup-name=${BACKUP_NAME}] backup-name differs from server; skipping postgres archive_command config and pgbackrest stanza-create/check"
fi

echo "==> [server=${SERVER} backup-name=${BACKUP_NAME}] done"
