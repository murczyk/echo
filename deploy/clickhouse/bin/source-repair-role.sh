#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

[[ $# -eq 1 ]] || die "usage: $0 --check|--yes"
case $1 in
  --check|--yes) ;;
  *) die "usage: $0 --check|--yes" ;;
esac

load_source_config
validate_identifier SOURCE_DB "$SOURCE_DB"
validate_identifier SOURCE_USER "$SOURCE_USER"

if [[ $1 == --yes ]]; then
  acquire_source_reconcile_lock
  source_local_psql -q -v ON_ERROR_STOP=1 \
    -v source_user="$SOURCE_USER" \
    -v source_db="$SOURCE_DB" <<'SQL'
BEGIN;
SELECT format('ALTER ROLE %I WITH LOGIN REPLICATION BYPASSRLS', :'source_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'source_db', :'source_user') \gexec
COMMIT;
SQL
fi

require_source_replication_role
log "Source replication role permissions are valid; recovering a missing or lost slot requires an explicit mirror resync"
