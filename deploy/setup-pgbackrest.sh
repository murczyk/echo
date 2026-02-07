#!/usr/bin/env bash
set -euo pipefail

SERVER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)
      SERVER="${2:-}"
      shift 2
      ;;
    --help|-h)
      echo "usage: $0 --server <server>" >&2
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "usage: $0 --server <server>" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${SERVER}" ]]; then
  echo "missing required argument: --server <server>" >&2
  exit 2
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

echo "==> [${SERVER}] ensure pgdg apt repo + pgbackrest package"
ssh "${SERVER}" "sudo echo-install-utils install-pgbackrest"

echo "==> [${SERVER}] ensure /etc/pgbackrest/pgbackrest.conf base config"
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

REMOTE_TMP="/tmp/pgbackrest.${SERVER}.conf"

echo "==> [${SERVER}] sync ${REMOTE_TMP} from Bitwarden"
BW_NOTE="echo-pgbackrest-${SERVER}"
BW_EXIT_CODE=0
set +e
"${ECHO_INSTALL_UTILS_BIN}" bw-sync "${SERVER}" "${BW_NOTE}" "${REMOTE_TMP}" --no-restart --exit-code
BW_EXIT_CODE="$?"
set -e
if [[ "${BW_EXIT_CODE}" -ne 0 && "${BW_EXIT_CODE}" -ne 2 ]]; then
  echo "bw-sync failed with exit code ${BW_EXIT_CODE}" >&2
  exit "${BW_EXIT_CODE}"
fi

echo "==> [${SERVER}] detect pgBackRest stanza from ${REMOTE_TMP}"
STANZA="$(
  ssh "${SERVER}" "sudo CONF_PATH='${REMOTE_TMP}' bash -s" <<'REMOTE'
set -euo pipefail

CONF="${CONF_PATH:?}"
stanza="$(
  sed -nE 's/^[[:space:]]*\[([^]]+)\][[:space:]]*$/\1/p' "$CONF" \
    | grep -vE '^global(:|$)' \
    | head -n 1 || true
)"

if [[ -n "${stanza}" ]]; then
  printf '%s' "${stanza}"
fi
REMOTE
)"
if [[ -z "${STANZA}" ]]; then
  echo "failed to detect stanza from ${REMOTE_TMP} on ${SERVER}" >&2
  exit 1
fi
echo "stanza=${STANZA}"

SERVER_PGBR_CONF="/etc/pgbackrest/conf.d/pgbackrest-${STANZA}.conf"

echo "==> [${SERVER}] install ${SERVER_PGBR_CONF}"
ssh "${SERVER}" "sudo REMOTE_TMP='${REMOTE_TMP}' SERVER_PGBR_CONF='${SERVER_PGBR_CONF}' bash -s" <<'REMOTE'
set -euo pipefail

REMOTE_TMP="${REMOTE_TMP:?}"
SERVER_PGBR_CONF="${SERVER_PGBR_CONF:?}"

install -d -m 0755 /etc/pgbackrest/conf.d

if cmp -s "${REMOTE_TMP}" "${SERVER_PGBR_CONF}" 2>/dev/null; then
  echo "config unchanged"
else
  install -m 0644 -o root -g root "${REMOTE_TMP}" "${SERVER_PGBR_CONF}"
fi

rm -f "${REMOTE_TMP}"

# IMPORTANT: pgBackRest on Debian/Ubuntu reads /etc/pgbackrest/pgbackrest.conf and
# also reads /etc/pgbackrest/conf.d/*.conf. If /etc/pgbackrest/pgbackrest.conf is
# a symlink into conf.d, it will double-load the same config and fail with:
# "option 'pg1-path' cannot be set multiple times" (exit code 31).
if [[ -L /etc/pgbackrest/pgbackrest.conf ]]; then
  rm -f /etc/pgbackrest/pgbackrest.conf
fi

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

TMP_90="/tmp/90-pgbackrest.${SERVER}.conf"
sed -e "s/@STANZA@/${STANZA}/g" "deploy/postgresql/90-pgbackrest.conf.template" > "${TMP_90}"

echo "==> [${SERVER}] ensure /etc/postgresql/14/main/conf.d/90-pgbackrest.conf"
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

if [[ "${CONF_CHANGED}" == "true" ]]; then
  echo "==> [${SERVER}] postgres config changed, restarting cluster 14/main"
  ssh "${SERVER}" "sudo pg_ctlcluster 14 main restart"
else
  echo "==> [${SERVER}] postgres config unchanged, restart skipped"
fi

echo "==> [${SERVER}] ensure stanza exists, then pgbackrest check"
ssh "${SERVER}" "set -euo pipefail; \
  sudo -u postgres pgbackrest --config='/etc/pgbackrest/pgbackrest.conf' --config-include-path='/etc/pgbackrest/conf.d' --stanza='${STANZA}' --log-level-console=info stanza-create; \
  sudo -u postgres pgbackrest --config='/etc/pgbackrest/pgbackrest.conf' --config-include-path='/etc/pgbackrest/conf.d' --stanza='${STANZA}' --log-level-console=info check"

rm -f "${TMP_90}"
echo "==> [${SERVER}] done"
