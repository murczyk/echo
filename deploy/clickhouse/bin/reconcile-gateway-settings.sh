#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_analytics_config
validate_runtime_identifiers

check_only=false
case ${1:-} in
  '')
    ;;
  --check)
    check_only=true
    ;;
  *)
    die "usage: $0 [--check]"
    ;;
esac

gateway_mergejoin_disabled() {
  postgres_psql --dbname postgres -Atq \
    -v ON_ERROR_STOP=1 \
    -v gateway_user="$GATEWAY_USER" <<'SQL'
SELECT coalesce(
  (
    SELECT rolconfig @> ARRAY['enable_mergejoin=off']
    FROM pg_roles
    WHERE rolname = :'gateway_user'
  ),
  false
);
SQL
}

if $check_only; then
  [[ $(gateway_mergejoin_disabled) == t ]] \
    || die "analytics gateway role must disable merge joins"
  exit 0
fi

postgres_psql --dbname postgres \
  -v ON_ERROR_STOP=1 \
  -v gateway_user="$GATEWAY_USER" <<'SQL' >/dev/null
SELECT format('ALTER ROLE %I SET enable_mergejoin = off', :'gateway_user') \gexec
SQL
[[ $(gateway_mergejoin_disabled) == t ]] \
  || die "failed to disable analytics gateway merge joins"
log "Analytics gateway query settings are reconciled"
