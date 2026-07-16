#!/usr/bin/env bash
# Re-registers echo-ai-train's tailscale IP for PostgreSQL access on remote DB servers.
#
# Unlike db-ct.sh (which is piped straight onto one server and targets PostgreSQL 18),
# this fixes the listen_addresses / pg_hba.conf entries and auto-detects the running
# cluster/version, so it is not tied to a PostgreSQL major version. Use it after a
# major-version upgrade where pg_upgrade writes a fresh config and drops those
# entries. It only touches connectivity; pgBackRest nightly-restore setup lives in db-ct.sh.
#
# The hop from echo-ai-train to the database servers must use the SSH keys stored on
# echo-ai-train, so ProxyJump (ssh -J) won't work (that would use the local keys).
# Instead this script pipes itself to echo-ai-train, re-runs there in --on-train mode,
# and from there ssh's into each DB server. The tailscale IP registered is echo-ai-train's
# own, read on echo-ai-train.
#
# Usage (run as a file, not piped):
#   ./pg-access.sh <db-host> [<db-host> ...]
#
# Example:
#   ./pg-access.sh ct-echo-kherson2-dev.alpines-banded.ts.net \
#                  echo-skhid-dev.serengeti-porbeagle.ts.net
#
# Overridable via environment:
#   TRAIN_HOST   SSH alias/host of the jump host (default: echo-ai-train)
#   DB_USER      SSH user on the database servers (default: echo)
set -euo pipefail

MODE="driver"
if [ "${1:-}" = "--on-train" ]; then
    MODE="on-train"
    shift
fi

TRAIN_HOST="${TRAIN_HOST:-echo-ai-train}"
DB_USER="${DB_USER:-echo}"

usage() {
    echo "Usage: $0 <db-host> [<db-host> ...]" >&2
    echo "Runs on ${TRAIN_HOST} and grants its tailscale IP PostgreSQL access on each <db-host>." >&2
}

if [ "$#" -lt 1 ]; then
    usage
    exit 1
fi

if [ "${MODE}" = "driver" ]; then
    # Pipe this script to the jump host and re-run it there, so that the hop to the
    # database servers uses the SSH keys stored on ${TRAIN_HOST}.
    echo "==> running on ${TRAIN_HOST} (its keys reach the DB servers)"
    exec ssh "${TRAIN_HOST}" DB_USER="${DB_USER}" bash -s -- --on-train "$@" < "$0"
fi

# --- on-train mode: everything below runs on ${TRAIN_HOST} ---

# echo-ai-train's own tailscale IP is the address that needs pg access.
TRAIN_IP="$(tailscale ip -4 | head -n1)"
if ! [[ "${TRAIN_IP}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    echo "Could not determine tailscale IPv4 on this host (got: '${TRAIN_IP}')" >&2
    exit 1
fi
echo "    tailscale IP to register: ${TRAIN_IP}"

# Load the credentials echo-ai-train uses (PGUSER/PGPASSWORD) so we can verify the
# connection with psql after each server is reconfigured. This is the .env that
# `just setup-echo-ai-train` rsyncs to ~/echo-ai on the train host.
TRAIN_ENV="${TRAIN_ENV:-${HOME}/echo-ai/.env}"
if [ -f "${TRAIN_ENV}" ]; then
    set -a; . "${TRAIN_ENV}"; set +a
fi
PG_CHECK_USER="${PGUSER:-wd}"
PG_CHECK_DB="${PGDATABASE:-wd}"

# Verify that this host (echo-ai-train) can actually reach PostgreSQL on ${host} over
# tailscale. Retries briefly to ride out the restart window.
check_connectivity() {
    local host="$1" attempt
    if ! command -v psql > /dev/null 2>&1; then
        echo "    psql not found on $(hostname); skipping connectivity check for ${host}" >&2
        return 0
    fi
    for attempt in 1 2 3 4 5; do
        if psql "host=${host} dbname=${PG_CHECK_DB} user=${PG_CHECK_USER} connect_timeout=10" \
            -tAXc 'select 1' > /dev/null 2>&1; then
            echo "    ${host}: connectivity OK (${PG_CHECK_USER}@${PG_CHECK_DB})"
            return 0
        fi
        sleep 2
    done
    echo "    ${host}: configured but psql connection FAILED (${PG_CHECK_USER}@${PG_CHECK_DB})" >&2
    return 1
}

failures=()
for host in "$@"; do
    echo "==> ${host}"
    # ssh into the DB server using this host's (echo-ai-train's) keys and run the
    # configurator remotely. The tailscale IP is passed as a positional argument.
    if ssh "${DB_USER}@${host}" "bash -s" -- "${TRAIN_IP}" <<'REMOTE'
set -eu
TRAIN_IP="${1:-}"
if [ -z "${TRAIN_IP}" ]; then
    echo "no train IP provided to remote configurator" >&2
    exit 1
fi

if ! command -v jq > /dev/null 2>&1; then
    sudo apt-get -y install jq
fi

# Pick the target cluster: the highest-versioned online cluster, falling back to the
# highest-versioned configured cluster. Works whether the box is on 14, 18, or mid-upgrade.
cluster_line="$(pg_lsclusters --no-header 2>/dev/null | awk '$4 == "online"' | sort -k1,1 -rn | head -n1)"
if [ -z "${cluster_line}" ]; then
    cluster_line="$(pg_lsclusters --no-header 2>/dev/null | sort -k1,1 -rn | head -n1)"
fi
if [ -z "${cluster_line}" ]; then
    echo "no PostgreSQL cluster found on this host" >&2
    exit 1
fi
PG_VERSION="$(echo "${cluster_line}" | awk '{print $1}')"
PG_CLUSTER="$(echo "${cluster_line}" | awk '{print $2}')"

CONF_DIR="/etc/postgresql/${PG_VERSION}/${PG_CLUSTER}"
POSTGRES_CONF="${CONF_DIR}/postgresql.conf"
PG_HBA_CONF="${CONF_DIR}/pg_hba.conf"
SERVICE="postgresql@${PG_VERSION}-${PG_CLUSTER}.service"
echo "configuring PostgreSQL ${PG_VERSION}/${PG_CLUSTER}"

restart=0
reload=0

# --- listen_addresses ---
DOMAIN="$(tailscale status --json | jq -r '.CertDomains[0] // empty')"
if [ -z "${DOMAIN}" ]; then
    echo "unable to determine tailscale cert domain on this host" >&2
    exit 1
fi
DESIRED="listen_addresses = 'localhost, ${DOMAIN}'"
if grep -qE "^[[:space:]]*listen_addresses[[:space:]]*=" "${POSTGRES_CONF}"; then
    if ! grep -qE "^[[:space:]]*listen_addresses[[:space:]]*=.*${DOMAIN}" "${POSTGRES_CONF}"; then
        echo "updating listen_addresses to include ${DOMAIN}"
        sudo sed -i "s|^[[:space:]]*listen_addresses[[:space:]]*=.*|${DESIRED}|" "${POSTGRES_CONF}"
        restart=1
    fi
else
    echo "setting listen_addresses to localhost and ${DOMAIN}"
    sudo sed -i "s|^[[:space:]]*#listen_addresses.*|${DESIRED}|" "${POSTGRES_CONF}"
    restart=1
fi

# --- pg_hba.conf ---
if ! sudo grep -qF "${TRAIN_IP}/32" "${PG_HBA_CONF}"; then
    echo "adding echo-ai-train (${TRAIN_IP}) to pg_hba.conf"
    printf '%s\n' \
        "# echo-ai-train" \
        "host    wd              wd              ${TRAIN_IP}/32            scram-sha-256" \
        | sudo tee -a "${PG_HBA_CONF}" > /dev/null
    reload=1
fi

if [ "${restart}" -eq 1 ]; then
    echo "restarting ${SERVICE}"
    sudo systemctl restart "${SERVICE}"
elif [ "${reload}" -eq 1 ]; then
    echo "reloading ${SERVICE}"
    sudo systemctl reload "${SERVICE}"
else
    echo "no changes needed; ${TRAIN_IP} already has access"
fi
REMOTE
    then
        if ! check_connectivity "${host}"; then
            failures+=("${host}")
        fi
    else
        echo "    ${host}: configuration FAILED" >&2
        failures+=("${host}")
    fi
done

if [ "${#failures[@]}" -gt 0 ]; then
    echo "==> failed hosts: ${failures[*]}" >&2
    exit 1
fi
echo "==> done"
