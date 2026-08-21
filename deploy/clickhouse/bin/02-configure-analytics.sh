#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=./clickhouse-system-log-policy.sh
source "$SCRIPT_DIR/clickhouse-system-log-policy.sh"
load_analytics_config
validate_runtime_identifiers
validate_ipv4_address ANALYTICS_LISTEN_ADDRESS "$ANALYTICS_LISTEN_ADDRESS"
validate_ipv4_address ANALYTICS_ALLOWED_CLIENT "$ANALYTICS_ALLOWED_CLIENT"

for command in base64 clickhouse clickhouse-client cmp jq openssl pg_conftool psql ss sudo systemctl; do
  require_cmd "$command"
done
[[ ${ANALYTICS_GATEWAY_STATEMENT_TIMEOUT_MS:-25000} =~ ^[1-9][0-9]*$ ]] \
  || die "ANALYTICS_GATEWAY_STATEMENT_TIMEOUT_MS must be a positive integer"
[[ -x /opt/temporal/bin/temporal-sql-tool ]] || die "Temporal artifacts are not installed"
[[ -f /usr/lib/postgresql/$POSTGRESQL_MAJOR/lib/pg_clickhouse.so ]] \
  || die "pg_clickhouse is not installed for PostgreSQL $POSTGRESQL_MAJOR"
[[ -f /usr/share/postgresql/$POSTGRESQL_MAJOR/extension/pg_stat_statements.control ]] \
  || die "pg_stat_statements is not installed for PostgreSQL $POSTGRESQL_MAJOR"

enc_key=$(jq -er --arg id "$PEERDB_CURRENT_ENC_KEY_ID" \
  '.[] | select(.id == $id) | .value' <<<"$PEERDB_ENC_KEYS") \
  || die "PEERDB_ENC_KEYS does not contain PEERDB_CURRENT_ENC_KEY_ID"
decoded_key_size=$(printf '%s' "$enc_key" | base64 --decode | wc -c)
[[ "$decoded_key_size" -eq 32 ]] || die "PeerDB encryption key must decode to exactly 32 bytes"

sudo chown root:echo-analytics "$INSTANCE_FILE" "$CLICKHOUSE_SECRETS_FILE" "$PEERDB_SECRETS_FILE"
sudo chmod 0640 "$INSTANCE_FILE" "$CLICKHOUSE_SECRETS_FILE" "$PEERDB_SECRETS_FILE"

log "Configuring the local PostgreSQL $POSTGRESQL_MAJOR gateway and service databases"
sudo pg_conftool "$POSTGRESQL_MAJOR" main set listen_addresses "127.0.0.1,$ANALYTICS_LISTEN_ADDRESS"
sudo pg_conftool "$POSTGRESQL_MAJOR" main set port "${ANALYTICS_GATEWAY_PORT:-5432}"
shared_preload_libraries=$(sudo pg_conftool -s "$POSTGRESQL_MAJOR" main \
  show shared_preload_libraries || true)
if [[ ",${shared_preload_libraries// /}," != *,pg_stat_statements,* ]]; then
  shared_preload_libraries=${shared_preload_libraries:+$shared_preload_libraries,}
  shared_preload_libraries+=pg_stat_statements
fi
sudo pg_conftool "$POSTGRESQL_MAJOR" main set \
  shared_preload_libraries "$shared_preload_libraries"
hba_file=/etc/postgresql/$POSTGRESQL_MAJOR/main/pg_hba.conf
hba_clean=$(mktemp /tmp/echo-analytics-hba-clean.XXXXXX)
hba_tmp=$(mktemp /tmp/echo-analytics-hba.XXXXXX)
trap 'rm -f -- "$hba_clean" "$hba_tmp"' EXIT
# sudo is required to read hba_file, not for the redirect.
# shellcheck disable=SC2024
sudo awk '
  $0 == "# BEGIN ECHO ANALYTICS" { managed = 1; next }
  $0 == "# END ECHO ANALYTICS" { managed = 0; next }
  !managed { print }
' "$hba_file" >"$hba_clean"
cat >"$hba_tmp" <<EOF
# BEGIN ECHO ANALYTICS
host    $GATEWAY_DB    $GATEWAY_USER    127.0.0.1/32                   scram-sha-256
host    $GATEWAY_DB    $GATEWAY_USER    ::1/128                        scram-sha-256
host    $GATEWAY_DB    $GATEWAY_USER    $ANALYTICS_ALLOWED_CLIENT    scram-sha-256
host    all            $GATEWAY_USER    0.0.0.0/0                     reject
host    all            $GATEWAY_USER    ::/0                          reject
# END ECHO ANALYTICS
EOF
cat "$hba_clean" >>"$hba_tmp"
sudo install -o postgres -g postgres -m 0640 "$hba_tmp" "$hba_file"
sudo systemctl restart "postgresql@$POSTGRESQL_MAJOR-main.service"

{
  psql_set_secret catalog_password_b64 "$CATALOG_PASSWORD"
  psql_set_secret temporal_password_b64 "$TEMPORAL_PASSWORD"
  psql_set_secret gateway_password_b64 "$GATEWAY_PASSWORD"
  cat <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L',
  :'catalog_user',
  convert_from(decode(:'catalog_password_b64', 'base64'), 'UTF8')
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'catalog_user') \gexec
SELECT format(
  'ALTER ROLE %I LOGIN PASSWORD %L',
  :'catalog_user',
  convert_from(decode(:'catalog_password_b64', 'base64'), 'UTF8')
) \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'catalog_db', :'catalog_user')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'catalog_db') \gexec

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L',
  :'temporal_user',
  convert_from(decode(:'temporal_password_b64', 'base64'), 'UTF8')
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'temporal_user') \gexec
SELECT format(
  'ALTER ROLE %I LOGIN PASSWORD %L',
  :'temporal_user',
  convert_from(decode(:'temporal_password_b64', 'base64'), 'UTF8')
) \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'temporal_db', :'temporal_user')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'temporal_db') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'temporal_visibility_db', :'temporal_user')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'temporal_visibility_db') \gexec

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L',
  :'gateway_user',
  convert_from(decode(:'gateway_password_b64', 'base64'), 'UTF8')
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'gateway_user') \gexec
SELECT format(
  'ALTER ROLE %I LOGIN PASSWORD %L',
  :'gateway_user',
  convert_from(decode(:'gateway_password_b64', 'base64'), 'UTF8')
) \gexec
SELECT format('CREATE DATABASE %I OWNER postgres', :'gateway_db')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'gateway_db') \gexec
SELECT format('ALTER DATABASE %I OWNER TO postgres', :'gateway_db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM %I', :'gateway_db', :'gateway_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'gateway_db', :'gateway_user') \gexec
SELECT format(
  'ALTER ROLE %I SET statement_timeout = %L',
  :'gateway_user',
  :'gateway_statement_timeout'
) \gexec
SELECT format('ALTER ROLE %I SET enable_mergejoin = off', :'gateway_user') \gexec
SQL
} | postgres_psql \
  -v ON_ERROR_STOP=1 \
  -v catalog_user="$CATALOG_USER" \
  -v catalog_db="$CATALOG_DB" \
  -v temporal_user="$TEMPORAL_USER" \
  -v temporal_db="$TEMPORAL_DB" \
  -v temporal_visibility_db="$TEMPORAL_VISIBILITY_DB" \
  -v gateway_user="$GATEWAY_USER" \
  -v gateway_db="$GATEWAY_DB" \
  -v gateway_statement_timeout="${ANALYTICS_GATEWAY_STATEMENT_TIMEOUT_MS:-25000}ms" \
  --dbname postgres

temporal_schema_setup() {
  local database=$1
  local schema_kind=$2
  local versioned_dir="/opt/temporal/schema/postgresql/v12/${schema_kind}/versioned"
  local schema_exists
  schema_exists=$(postgres_psql --dbname "$database" -Atqc "SELECT to_regclass('public.schema_version') IS NOT NULL")
  if [[ "$schema_exists" != t ]]; then
    SQL_HOST=127.0.0.1 \
    SQL_PORT="${ANALYTICS_GATEWAY_PORT:-5432}" \
    SQL_USER="$TEMPORAL_USER" \
    SQL_PASSWORD="$TEMPORAL_PASSWORD" \
    SQL_DATABASE="$database" \
    SQL_PLUGIN=postgres12 \
      /opt/temporal/bin/temporal-sql-tool setup-schema -v 0.0
  fi
  SQL_HOST=127.0.0.1 \
  SQL_PORT="${ANALYTICS_GATEWAY_PORT:-5432}" \
  SQL_USER="$TEMPORAL_USER" \
  SQL_PASSWORD="$TEMPORAL_PASSWORD" \
  SQL_DATABASE="$database" \
  SQL_PLUGIN=postgres12 \
    /opt/temporal/bin/temporal-sql-tool update-schema -d "$versioned_dir"
}

log "Initializing Temporal PostgreSQL schemas"
temporal_schema_setup "$TEMPORAL_DB" temporal
temporal_schema_setup "$TEMPORAL_VISIBILITY_DB" visibility

log "Installing the pg_clickhouse extension into the gateway"
postgres_psql --dbname "$GATEWAY_DB" -v ON_ERROR_STOP=1 -v gateway_user="$GATEWAY_USER" <<'SQL'
CREATE SCHEMA IF NOT EXISTS pgch AUTHORIZATION postgres;
CREATE EXTENSION IF NOT EXISTS pg_clickhouse SCHEMA pgch;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;
REVOKE ALL ON TABLE public.pg_stat_statements FROM PUBLIC;
REVOKE ALL ON TABLE public.pg_stat_statements_info FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pg_stat_statements(boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pg_stat_statements_info() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pg_stat_statements_reset(oid, oid, bigint, boolean)
FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'gateway_user') \gexec
CREATE TABLE IF NOT EXISTS public.echo_analytics_health (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  checked_at timestamptz NOT NULL DEFAULT '-infinity',
  healthy boolean NOT NULL DEFAULT false,
  source_lsn pg_lsn,
  confirmed_flush_lsn pg_lsn,
  detail text NOT NULL DEFAULT 'not checked'
);
ALTER TABLE public.echo_analytics_health OWNER TO postgres;
INSERT INTO public.echo_analytics_health (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;
REVOKE ALL ON TABLE public.echo_analytics_health FROM PUBLIC;
SELECT format(
  'GRANT SELECT ON TABLE public.echo_analytics_health TO %I',
  :'gateway_user'
) \gexec
SELECT pgch.pgch_version();
SQL

log "Configuring ClickHouse for local-only access"
admin_hash=$(printf '%s' "$CLICKHOUSE_ADMIN_PASSWORD" | sha256sum | awk '{print $1}')
clickhouse_memory_limit=$(clickhouse_memory_limit_bytes)
sudo install -d -m 0755 /etc/clickhouse-server/config.d /etc/clickhouse-server/users.d
sudo tee /etc/clickhouse-server/config.d/echo-analytics.xml >/dev/null <<EOF
<clickhouse>
  <listen_host>127.0.0.1</listen_host>
  <listen_host>::1</listen_host>
  <tcp_port>${CLICKHOUSE_NATIVE_PORT:-9000}</tcp_port>
  <http_port>${CLICKHOUSE_HTTP_PORT:-8123}</http_port>
  <max_server_memory_usage_to_ram_ratio>0.55</max_server_memory_usage_to_ram_ratio>
</clickhouse>
EOF
sudo tee /etc/clickhouse-server/config.d/echo-memory-limit.xml >/dev/null <<EOF
<clickhouse>
  <max_server_memory_usage>$clickhouse_memory_limit</max_server_memory_usage>
</clickhouse>
EOF
sudo tee /etc/clickhouse-server/users.d/echo-analytics.xml >/dev/null <<EOF
<clickhouse>
  <users>
    <default replace="replace">
      <password_sha256_hex>${admin_hash}</password_sha256_hex>
      <networks>
        <ip>127.0.0.1</ip>
        <ip>::1</ip>
      </networks>
      <profile>default</profile>
      <quota>default</quota>
      <access_management>1</access_management>
      <named_collection_control>1</named_collection_control>
    </default>
  </users>
</clickhouse>
EOF
sudo chmod 0640 \
  /etc/clickhouse-server/config.d/echo-analytics.xml \
  /etc/clickhouse-server/users.d/echo-analytics.xml
sudo chmod 0644 /etc/clickhouse-server/config.d/echo-memory-limit.xml
sudo chown root:clickhouse \
  /etc/clickhouse-server/config.d/echo-analytics.xml \
  /etc/clickhouse-server/config.d/echo-memory-limit.xml \
  /etc/clickhouse-server/users.d/echo-analytics.xml
sudo systemctl restart clickhouse-server
wait_for_command ClickHouse clickhouse_admin --query 'SELECT 1'
# Keep the existing system-log table identities when the configured TTLs become active.
clickhouse_admin --query 'SYSTEM FLUSH LOGS'
apply_clickhouse_system_log_ttls
install_clickhouse_system_log_config
sudo systemctl restart clickhouse-server
wait_for_command ClickHouse clickhouse_admin --query 'SELECT 1'
verify_clickhouse_system_log_policy

while IFS= read -r listener; do
  case "$listener" in
    127.0.0.1:*|'[::1]':*)
      ;;
    *)
      die "ClickHouse unexpectedly listens outside loopback: $listener"
      ;;
  esac
done < <(
  ss -H -ltn | awk -v tcp=":${CLICKHOUSE_NATIVE_PORT:-9000}" -v http=":${CLICKHOUSE_HTTP_PORT:-8123}" \
    '$4 ~ tcp "$" || $4 ~ http "$" { print $4 }'
)

peerdb_password_sql=$(sql_literal "$CLICKHOUSE_PEERDB_PASSWORD")
gateway_password_sql=$(sql_literal "$CLICKHOUSE_GATEWAY_PASSWORD")
clickhouse_admin --multiquery <<SQL
CREATE DATABASE IF NOT EXISTS $CLICKHOUSE_RAW_DB;
CREATE DATABASE IF NOT EXISTS $CLICKHOUSE_CURRENT_DB;
CREATE USER IF NOT EXISTS $CLICKHOUSE_PEERDB_USER IDENTIFIED WITH sha256_password BY '$peerdb_password_sql' HOST LOCAL;
ALTER USER $CLICKHOUSE_PEERDB_USER IDENTIFIED WITH sha256_password BY '$peerdb_password_sql' HOST LOCAL;
CREATE USER IF NOT EXISTS $CLICKHOUSE_GATEWAY_USER IDENTIFIED WITH sha256_password BY '$gateway_password_sql' HOST LOCAL;
ALTER USER $CLICKHOUSE_GATEWAY_USER IDENTIFIED WITH sha256_password BY '$gateway_password_sql' HOST LOCAL;
GRANT SELECT, INSERT, CREATE TABLE, ALTER, DROP, TRUNCATE ON $CLICKHOUSE_RAW_DB.* TO $CLICKHOUSE_PEERDB_USER;
GRANT CREATE TEMPORARY TABLE, s3 ON *.* TO $CLICKHOUSE_PEERDB_USER;
GRANT SELECT ON $CLICKHOUSE_RAW_DB.* TO $CLICKHOUSE_GATEWAY_USER;
GRANT SELECT ON $CLICKHOUSE_CURRENT_DB.* TO $CLICKHOUSE_GATEWAY_USER;
SQL

log "Rendering Temporal server configuration"
temporal_password_yaml=$(toml_or_yaml_double_quote "$TEMPORAL_PASSWORD")
temporal_password_yaml=$(sed_replacement_escape "$temporal_password_yaml")
sed \
  -e "s/__TEMPORAL_DB__/$TEMPORAL_DB/g" \
  -e "s/__TEMPORAL_VISIBILITY_DB__/$TEMPORAL_VISIBILITY_DB/g" \
  -e "s/__TEMPORAL_USER__/$TEMPORAL_USER/g" \
  -e "s/__POSTGRES_PORT__/${ANALYTICS_GATEWAY_PORT:-5432}/g" \
  -e "s/__TEMPORAL_PORT__/${TEMPORAL_PORT:-7233}/g" \
  -e "s|__TEMPORAL_PASSWORD__|$temporal_password_yaml|g" \
  "$BUNDLE_DIR/templates/temporal.yaml" >"$hba_tmp"
sudo install -o root -g echo-analytics -m 0640 "$hba_tmp" /etc/echo-analytics/temporal.yaml
sudo install -o root -g echo-analytics -m 0640 \
  "$BUNDLE_DIR/templates/temporal-dynamicconfig.yaml" \
  /etc/echo-analytics/temporal-dynamicconfig.yaml
sudo -u echo-analytics /opt/temporal/bin/temporal-server validate-dynamic-config \
  /etc/echo-analytics/temporal-dynamicconfig.yaml

log "Analytics databases and local service configuration are ready"
