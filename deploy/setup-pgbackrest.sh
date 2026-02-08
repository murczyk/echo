#!/usr/bin/env bash
set -euo pipefail

SERVER=""
TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)
      SERVER="${2:-}"
      shift 2
      ;;
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --help|-h)
      echo "usage: $0 --server <server> [--target <ssh-host>]" >&2
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "usage: $0 --server <server> [--target <ssh-host>]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${SERVER}" ]]; then
  echo "missing required argument: --server <server>" >&2
  exit 2
fi

if [[ -z "${TARGET}" ]]; then
  TARGET="${SERVER}"
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

ECHO_INSTALL_UTILS_BIN="${ECHO_INSTALL_UTILS_BIN:-echo-install-utils}"

echo "==> [server=${SERVER} target=${TARGET}] ensure pgdg apt repo + pgbackrest package"
ssh "${TARGET}" "sudo echo-install-utils install-pgbackrest"

echo "==> [server=${SERVER} target=${TARGET}] ensure /etc/pgbackrest/pgbackrest.conf base config"
ssh "${TARGET}" "sudo bash -s" <<'REMOTE'
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
if [[ "${TARGET}" == "${SERVER}" ]]; then
  echo "==> [server=${SERVER} target=${TARGET}] detect pgBackRest stanza (existing config)"
  STANZA="$(
    ssh "${TARGET}" "sudo bash -s" <<'REMOTE'
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
      sed -nE 's/^[[:space:]]*\\[([^]]+)\\][[:space:]]*$/\\1/p' "${files[0]}" \
        | grep -vE '^global(:|$)' \
        | head -n 1 || true
    )"
  fi
fi

if [[ -n "${stanza}" ]]; then
  printf '%s' "${stanza}"
fi
REMOTE
  )"
fi

BW_NOTE="echo-pgbackrest-${SERVER}"
BW_EXIT_CODE=0

if [[ -n "${STANZA}" ]]; then
  echo "stanza=${STANZA}"
  SERVER_PGBR_CONF="/etc/pgbackrest/conf.d/pgbackrest-${STANZA}.conf"

  echo "==> [server=${SERVER} target=${TARGET}] sync ${SERVER_PGBR_CONF} from Bitwarden"
  ssh "${TARGET}" "sudo install -d -m 0755 /etc/pgbackrest/conf.d"
  set +e
  "${ECHO_INSTALL_UTILS_BIN}" bw-sync "${TARGET}" "${BW_NOTE}" "${SERVER_PGBR_CONF}" --no-restart --exit-code
  BW_EXIT_CODE="$?"
  set -e
  if [[ "${BW_EXIT_CODE}" -ne 0 && "${BW_EXIT_CODE}" -ne 2 ]]; then
    echo "bw-sync failed with exit code ${BW_EXIT_CODE}" >&2
    exit "${BW_EXIT_CODE}"
  fi
  ssh "${TARGET}" "sudo chown root:root '${SERVER_PGBR_CONF}' && sudo chmod 0644 '${SERVER_PGBR_CONF}'"
else
  # First run: fetch note to temp, detect stanza, then install to final path.
  REMOTE_TMP="/tmp/pgbackrest.${SERVER}.conf"
  echo "==> [server=${SERVER} target=${TARGET}] sync ${REMOTE_TMP} from Bitwarden (for stanza detection)"
  set +e
  "${ECHO_INSTALL_UTILS_BIN}" bw-sync "${TARGET}" "${BW_NOTE}" "${REMOTE_TMP}" --no-restart --exit-code
  BW_EXIT_CODE="$?"
  set -e
  if [[ "${BW_EXIT_CODE}" -ne 0 && "${BW_EXIT_CODE}" -ne 2 ]]; then
    echo "bw-sync failed with exit code ${BW_EXIT_CODE}" >&2
    exit "${BW_EXIT_CODE}"
  fi

  echo "==> [server=${SERVER} target=${TARGET}] detect pgBackRest stanza from ${REMOTE_TMP}"
  STANZA="$(
    ssh "${TARGET}" "sudo CONF_PATH='${REMOTE_TMP}' bash -s" <<'REMOTE'
set -euo pipefail

CONF="${CONF_PATH:?}"
stanza="$(
  sed -nE 's/^[[:space:]]*\\[([^]]+)\\][[:space:]]*$/\\1/p' "$CONF" \
    | grep -vE '^global(:|$)' \
    | head -n 1 || true
)"

if [[ -n "${stanza}" ]]; then
  printf '%s' "${stanza}"
fi
REMOTE
  )"
  if [[ -z "${STANZA}" ]]; then
    echo "failed to detect stanza from ${REMOTE_TMP} on ${TARGET}" >&2
    exit 1
  fi
  echo "stanza=${STANZA}"

  SERVER_PGBR_CONF="/etc/pgbackrest/conf.d/pgbackrest-${STANZA}.conf"
  echo "==> [server=${SERVER} target=${TARGET}] install ${SERVER_PGBR_CONF}"
  ssh "${TARGET}" "sudo REMOTE_TMP='${REMOTE_TMP}' SERVER_PGBR_CONF='${SERVER_PGBR_CONF}' bash -s" <<'REMOTE'
set -euo pipefail

REMOTE_TMP="${REMOTE_TMP:?}"
SERVER_PGBR_CONF="${SERVER_PGBR_CONF:?}"

install -d -m 0755 /etc/pgbackrest/conf.d
install -m 0644 -o root -g root "${REMOTE_TMP}" "${SERVER_PGBR_CONF}"
rm -f "${REMOTE_TMP}"
REMOTE
fi

if [[ "${TARGET}" == "${SERVER}" ]]; then
  TMP_90="/tmp/90-pgbackrest.${SERVER}.conf"
  sed -e "s/@STANZA@/${STANZA}/g" "deploy/postgresql/90-pgbackrest.conf.template" > "${TMP_90}"

  echo "==> [server=${SERVER} target=${TARGET}] ensure /etc/postgresql/14/main/conf.d/90-pgbackrest.conf"
  CONF_CHANGED="false"
  set +e
  "${ECHO_INSTALL_UTILS_BIN}" ssh-sync-file --take-a --exit-code "${TMP_90}" "${TARGET}:/etc/postgresql/14/main/conf.d/90-pgbackrest.conf"
  RC="$?"
  set -e
  if [[ "${RC}" -eq 2 ]]; then
    CONF_CHANGED="true"
  elif [[ "${RC}" -ne 0 ]]; then
    echo "ssh-sync-file failed with exit code ${RC}" >&2
    exit "${RC}"
  fi

  ssh "${TARGET}" "sudo chown root:root /etc/postgresql/14/main/conf.d/90-pgbackrest.conf && sudo chmod 0644 /etc/postgresql/14/main/conf.d/90-pgbackrest.conf"

  if [[ "${CONF_CHANGED}" == "true" ]]; then
    echo "==> [server=${SERVER} target=${TARGET}] postgres config changed, restarting cluster 14/main"
    ssh "${TARGET}" "sudo pg_ctlcluster 14 main restart"
  else
    echo "==> [server=${SERVER} target=${TARGET}] postgres config unchanged, restart skipped"
  fi

  echo "==> [server=${SERVER} target=${TARGET}] ensure stanza exists, then pgbackrest check"
  ssh "${TARGET}" "set -euo pipefail; \
    sudo -u postgres pgbackrest --config='/etc/pgbackrest/pgbackrest.conf' --config-include-path='/etc/pgbackrest/conf.d' --stanza='${STANZA}' --log-level-console=info stanza-create; \
    sudo -u postgres pgbackrest --config='/etc/pgbackrest/pgbackrest.conf' --config-include-path='/etc/pgbackrest/conf.d' --stanza='${STANZA}' --log-level-console=info check"

  rm -f "${TMP_90}"
else
  echo "==> [server=${SERVER} target=${TARGET}] target differs from server; skipping postgres archive_command config and pgbackrest stanza-create/check"
fi

echo "==> [server=${SERVER} target=${TARGET}] done"
