#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
load_source_config
ensure_yes "${1:-}"

require_cmd awk
require_cmd base64
require_cmd psql
require_cmd sudo
require_cmd systemctl

validate_identifier SOURCE_DB "$SOURCE_DB"
validate_identifier SOURCE_USER "$SOURCE_USER"
validate_identifier SOURCE_PUBLICATION "$SOURCE_PUBLICATION"
validate_ipv4_address SOURCE_LISTEN_ADDRESS "$SOURCE_LISTEN_ADDRESS"
validate_ipv4_address ANALYTICS_ADDRESS "$ANALYTICS_ADDRESS"
require_analytics_heartbeat_table
read_local_source_tables
require_analytics_heartbeat_selected

current_slots=$(source_local_psql -Atqc "SHOW max_replication_slots")
current_senders=$(source_local_psql -Atqc "SHOW max_wal_senders")
target_slots=$((current_slots > SOURCE_MIN_REPLICATION_SLOTS ? current_slots : SOURCE_MIN_REPLICATION_SLOTS))
target_senders=$((current_senders > SOURCE_MIN_WAL_SENDERS ? current_senders : SOURCE_MIN_WAL_SENDERS))

log "Writing logical replication settings"
source_local_psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -v target_slots="$target_slots" \
  -v target_senders="$target_senders" \
  -v slot_keep_size="$SOURCE_MAX_SLOT_WAL_KEEP_SIZE" \
  -v slot_timeout="$SOURCE_IDLE_REPLICATION_SLOT_TIMEOUT" \
  -v listen_address="$SOURCE_LISTEN_ADDRESS" <<'SQL'
ALTER SYSTEM SET wal_level = 'logical';
SELECT format('ALTER SYSTEM SET max_replication_slots = %L', :'target_slots') \gexec
SELECT format('ALTER SYSTEM SET max_wal_senders = %L', :'target_senders') \gexec
SELECT format('ALTER SYSTEM SET max_slot_wal_keep_size = %L', :'slot_keep_size') \gexec
ALTER SYSTEM SET wal_sender_timeout = '60s';
SELECT format(
  'ALTER SYSTEM SET listen_addresses = %L',
  array_to_string(
    ARRAY(
      SELECT DISTINCT address
      FROM unnest(
        string_to_array(current_setting('listen_addresses'), ',') || ARRAY[:'listen_address']
      ) address
      WHERE address <> ''
    ),
    ','
  )
) \gexec
SELECT format('ALTER SYSTEM SET idle_replication_slot_timeout = %L', :'slot_timeout')
WHERE current_setting('server_version_num')::integer >= 180000 \gexec
SQL

hba_file=$(source_local_psql -Atqc "SHOW hba_file")
hba_clean=$(mktemp /tmp/echo-peerdb-hba-clean.XXXXXX)
hba_tmp=$(mktemp /tmp/echo-peerdb-hba.XXXXXX)
trap 'rm -f -- "$hba_clean" "$hba_tmp"' EXIT
sudo awk '
  $0 == "# BEGIN ECHO PEERDB" { managed = 1; next }
  $0 == "# END ECHO PEERDB" { managed = 0; next }
  !managed { print }
' "$hba_file" >"$hba_clean"
cat >"$hba_tmp" <<EOF
# BEGIN ECHO PEERDB
host    $SOURCE_DB      $SOURCE_USER    $ANALYTICS_ADDRESS    scram-sha-256
host    replication    $SOURCE_USER    $ANALYTICS_ADDRESS    scram-sha-256
host    replication    $SOURCE_USER    0.0.0.0/0              reject
host    replication    $SOURCE_USER    ::/0                   reject
host    all            $SOURCE_USER    0.0.0.0/0              reject
host    all            $SOURCE_USER    ::/0                   reject
# END ECHO PEERDB
EOF
cat "$hba_clean" >>"$hba_tmp"
sudo install -o postgres -g postgres -m 0640 "$hba_tmp" "$hba_file"

service="postgresql@${SOURCE_PG_MAJOR}-${SOURCE_PG_CLUSTER}.service"
log "Restarting $service"
sudo systemctl restart "$service"
systemctl is-active --quiet "$service" || die "$service did not restart"
[[ $(source_local_psql -Atqc "SHOW wal_level") == logical ]] || die "wal_level is not logical"

log "Creating the restricted replication role"
{
  psql_set_secret source_password_b64 "$SOURCE_PASSWORD"
  cat <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN REPLICATION BYPASSRLS PASSWORD %L',
  :'source_user',
  convert_from(decode(:'source_password_b64', 'base64'), 'UTF8')
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'source_user') \gexec
SELECT format(
  'ALTER ROLE %I WITH LOGIN REPLICATION BYPASSRLS PASSWORD %L',
  :'source_user',
  convert_from(decode(:'source_password_b64', 'base64'), 'UTF8')
) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'source_db', :'source_user') \gexec
SQL
} | source_local_psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -v source_user="$SOURCE_USER" \
  -v source_db="$SOURCE_DB"

log "Resetting the dedicated role to the selected table set"
source_local_psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -v source_user="$SOURCE_USER" <<'SQL'
SELECT format('GRANT USAGE ON SCHEMA %I TO %I', n.nspname, :'source_user')
FROM pg_namespace n
WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
  AND EXISTS (SELECT FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p'))
\gexec

SELECT format('REVOKE SELECT ON ALL TABLES IN SCHEMA %I FROM %I', n.nspname, :'source_user')
FROM pg_namespace n
WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
  AND EXISTS (SELECT FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p'))
\gexec
SQL

table_list=$(printf '%s, ' "${SOURCE_TABLES[@]}")
table_list=${table_list%, }
source_local_psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -v source_user="$SOURCE_USER" \
  -v table_list="$table_list" <<'SQL'
SELECT format('GRANT SELECT ON TABLE %s TO %I', :'table_list', :'source_user') \gexec
SELECT format(
  'REVOKE ALL PRIVILEGES ON TABLE echo_analytics.heartbeat FROM %I',
  :'source_user'
) \gexec
SELECT format(
  'GRANT SELECT, UPDATE (nonce, updated_at) ON TABLE echo_analytics.heartbeat TO %I',
  :'source_user'
) \gexec
SQL

log "Reconciling publication $SOURCE_PUBLICATION and full replica identities"
source_local_psql \
  -q \
  -v ON_ERROR_STOP=1 \
  -v publication="$SOURCE_PUBLICATION" \
  -v table_list="$table_list" <<'SQL'
SELECT CASE
  WHEN EXISTS (SELECT FROM pg_publication WHERE pubname = :'publication')
    THEN format('ALTER PUBLICATION %I SET TABLE %s', :'publication', :'table_list')
  ELSE format('CREATE PUBLICATION %I FOR TABLE %s', :'publication', :'table_list')
END \gexec

SELECT format(
  'ALTER TABLE %I.%I REPLICA IDENTITY FULL',
  publication_table.schemaname,
  publication_table.tablename
)
FROM pg_publication_tables publication_table
WHERE publication_table.pubname = :'publication'
\gexec
SQL

source_local_psql -q -v ON_ERROR_STOP=1 \
  -c "SELECT pg_logical_emit_message(true, 'echo_peerdb_preflight', 'configured')"
"$SCRIPT_DIR/install-source-monitor.sh" --yes
log "Source PostgreSQL configured for PeerDB"
