#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BUNDLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
VERSIONS_FILE="$BUNDLE_DIR/versions.env"
CONFIG_DIR=${ECHO_ANALYTICS_CONFIG_DIR:-/etc/echo-analytics}
INSTANCE_FILE=${ECHO_ANALYTICS_INSTANCE_FILE:-$CONFIG_DIR/instance.env}
CLICKHOUSE_SECRETS_FILE=${ECHO_ANALYTICS_CLICKHOUSE_SECRETS_FILE:-$CONFIG_DIR/clickhouse.env}
PEERDB_SECRETS_FILE=${ECHO_ANALYTICS_PEERDB_SECRETS_FILE:-$CONFIG_DIR/peerdb.env}
SOURCE_CONFIG_FILE=${ECHO_PEERDB_SOURCE_CONFIG_FILE:-/etc/echo-peerdb/source.env}
DEFAULT_SOURCE_TABLE_EXCLUDE_FILE=$BUNDLE_DIR/env/tables-exclude.txt.example
ANALYTICS_HEARTBEAT_SOURCE_SCHEMA=echo_analytics
ANALYTICS_HEARTBEAT_SOURCE_TABLE=heartbeat
ANALYTICS_HEARTBEAT_TARGET_TABLE=echo_analytics__heartbeat

log() {
  printf '[echo-analytics] %s\n' "$*"
}

die() {
  printf '[echo-analytics] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

require_file() {
  [[ -f "$1" ]] || die "missing file: $1"
}

parse_env_stream() {
  local path=$1
  local line line_number=0 key value
  declare -A parsed_keys=()

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    line=${line%$'\r'}
    line=${line#"${line%%[![:space:]]*}"}
    line=${line%"${line##*[![:space:]]}"}
    [[ -n "$line" && ${line:0:1} != '#' ]] || continue
    [[ "$line" == *=* ]] || die "invalid environment entry at $path:$line_number"

    key=${line%%=*}
    value=${line#*=}
    key=${key#"${key%%[![:space:]]*}"}
    key=${key%"${key##*[![:space:]]}"}
    value=${value#"${value%%[![:space:]]*}"}
    value=${value%"${value##*[![:space:]]}"}
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] \
      || die "invalid environment key at $path:$line_number"
    [[ -z "${parsed_keys[$key]:-}" ]] \
      || die "duplicate environment key at $path:$line_number: $key"
    parsed_keys["$key"]=1

    if [[ ${#value} -ge 2 && ${value:0:1} == "'" && ${value: -1} == "'" ]]; then
      value=${value:1:${#value}-2}
    elif [[ ${#value} -ge 2 && ${value:0:1} == '"' && ${value: -1} == '"' ]]; then
      value=${value:1:${#value}-2}
    elif [[ ${value:0:1} == "'" || ${value:0:1} == '"' \
      || ${value: -1} == "'" || ${value: -1} == '"' ]]; then
      die "unmatched environment quote at $path:$line_number"
    fi
    printf -v "$key" '%s' "$value"
  done
}

source_env_file() {
  local path=$1
  if [[ -r "$path" ]]; then
    parse_env_stream "$path" <"$path"
  elif command -v sudo >/dev/null 2>&1 && sudo -n test -f "$path"; then
    # Passwordless sudo is an installation prerequisite. Process substitution
    # keeps the root-owned secret out of temporary files.
    parse_env_stream "$path" < <(sudo -n cat -- "$path")
  else
    die "missing or unreadable file: $path"
  fi
}

protected_file_exists() {
  [[ -f "$1" ]] || { command -v sudo >/dev/null 2>&1 && sudo -n test -f "$1"; }
}

read_protected_file() {
  if [[ -r "$1" ]]; then
    command cat -- "$1"
  else
    sudo -n cat -- "$1"
  fi
}

load_versions() {
  require_file "$VERSIONS_FILE"
  # shellcheck disable=SC1090
  source "$VERSIONS_FILE"
}

load_instance() {
  source_env_file "$INSTANCE_FILE"

  : "${SOURCE_DB:?SOURCE_DB is required}"
  : "${SOURCE_HOST:?SOURCE_HOST is required}"
  : "${SOURCE_PORT:?SOURCE_PORT is required}"
  : "${SOURCE_USER:?SOURCE_USER is required}"
  : "${SOURCE_PUBLICATION:?SOURCE_PUBLICATION is required}"
  : "${SOURCE_PEER:?SOURCE_PEER is required}"
  : "${ANALYTICS_LISTEN_ADDRESS:?ANALYTICS_LISTEN_ADDRESS is required}"
  : "${ANALYTICS_ALLOWED_CLIENT:?ANALYTICS_ALLOWED_CLIENT is required}"
  : "${CATALOG_DB:?CATALOG_DB is required}"
  : "${CATALOG_USER:?CATALOG_USER is required}"
  : "${TEMPORAL_DB:?TEMPORAL_DB is required}"
  : "${TEMPORAL_VISIBILITY_DB:?TEMPORAL_VISIBILITY_DB is required}"
  : "${TEMPORAL_USER:?TEMPORAL_USER is required}"
  : "${GATEWAY_DB:?GATEWAY_DB is required}"
  : "${GATEWAY_USER:?GATEWAY_USER is required}"
  : "${CLICKHOUSE_RAW_DB:?CLICKHOUSE_RAW_DB is required}"
  : "${CLICKHOUSE_CURRENT_DB:?CLICKHOUSE_CURRENT_DB is required}"
  : "${CLICKHOUSE_PEERDB_USER:?CLICKHOUSE_PEERDB_USER is required}"
  : "${CLICKHOUSE_GATEWAY_USER:?CLICKHOUSE_GATEWAY_USER is required}"
  : "${CLICKHOUSE_PEER:?CLICKHOUSE_PEER is required}"
  : "${MIRROR_NAME:?MIRROR_NAME is required}"
}

require_secret() {
  local name=$1
  local value=${!name:-}

  [[ -n "$value" ]] || die "$name is required in the analytics secret files"
  [[ "$value" != replace-with-* ]] || die "$name still contains an example value"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$name must not contain newlines"
}

load_secrets() {
  source_env_file "$CLICKHOUSE_SECRETS_FILE"
  source_env_file "$PEERDB_SECRETS_FILE"

  local name
  for name in \
    SOURCE_PASSWORD \
    CATALOG_PASSWORD \
    TEMPORAL_PASSWORD \
    GATEWAY_PASSWORD \
    CLICKHOUSE_ADMIN_PASSWORD \
    CLICKHOUSE_PEERDB_PASSWORD \
    CLICKHOUSE_GATEWAY_PASSWORD \
    MINIO_ROOT_PASSWORD \
    PEERDB_PASSWORD \
    PEERDB_CURRENT_ENC_KEY_ID \
    PEERDB_ENC_KEYS
  do
    require_secret "$name"
  done
}

load_analytics_config() {
  load_versions
  load_instance
  load_secrets
}

load_source_config() {
  source_env_file "$SOURCE_CONFIG_FILE"

  : "${SOURCE_DB:?SOURCE_DB is required}"
  : "${SOURCE_USER:?SOURCE_USER is required}"
  : "${SOURCE_PUBLICATION:?SOURCE_PUBLICATION is required}"
  : "${SOURCE_PASSWORD:?SOURCE_PASSWORD is required}"
  : "${SOURCE_PG_MAJOR:?SOURCE_PG_MAJOR is required}"
  : "${SOURCE_PG_CLUSTER:?SOURCE_PG_CLUSTER is required}"
  : "${SOURCE_LISTEN_ADDRESS:?SOURCE_LISTEN_ADDRESS is required}"
  : "${ANALYTICS_ADDRESS:?ANALYTICS_ADDRESS is required}"
  : "${SOURCE_MAX_SLOT_WAL_KEEP_SIZE:?SOURCE_MAX_SLOT_WAL_KEEP_SIZE is required}"

  SOURCE_IDLE_REPLICATION_SLOT_TIMEOUT=${SOURCE_IDLE_REPLICATION_SLOT_TIMEOUT:-7d}
  SOURCE_MIN_REPLICATION_SLOTS=${SOURCE_MIN_REPLICATION_SLOTS:-10}
  SOURCE_MIN_WAL_SENDERS=${SOURCE_MIN_WAL_SENDERS:-10}
  SOURCE_TABLE_EXCLUDE_FILE=${SOURCE_TABLE_EXCLUDE_FILE:-/etc/echo-peerdb/tables-exclude.txt}
  WAL_WARN_PERCENT=${WAL_WARN_PERCENT:-75}
  WAL_CRITICAL_PERCENT=${WAL_CRITICAL_PERCENT:-90}
}

source_local_psql() {
  sudo -u postgres psql -X --dbname "$SOURCE_DB" "$@"
}

read_local_source_tables() {
  local exclude_file
  exclude_file=$(effective_source_exclude_file)
  read_exclusions "$exclude_file"

  declare -ga SOURCE_TABLES=()
  declare -gA DISCOVERED_TABLE_LOOKUP=()
  local table
  while IFS= read -r table; do
    [[ -n "$table" ]] || continue
    DISCOVERED_TABLE_LOOKUP["$table"]=1
    [[ -z "${EXCLUDED_TABLE_LOOKUP[$table]:-}" ]] || continue
    [[ "$table" =~ ^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$ ]] \
      || die "table requires quoted PeerDB mapping support: $table"
    SOURCE_TABLES+=("$table")
  done < <(
    source_local_psql -Atq -v ON_ERROR_STOP=1 <<'SQL'
SELECT n.nspname || '.' || c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname <> 'information_schema'
  AND n.nspname !~ '^pg_'
ORDER BY n.nspname, c.relname;
SQL
  )

  local excluded
  for excluded in "${!EXCLUDED_TABLE_LOOKUP[@]}"; do
    [[ -n "${DISCOVERED_TABLE_LOOKUP[$excluded]:-}" ]] \
      || die "excluded table does not exist: $excluded"
  done
  ((${#SOURCE_TABLES[@]} > 0)) || die "no source tables selected"
}

require_analytics_heartbeat_table() {
  local heartbeat_table
  heartbeat_table=$(source_local_psql -Atq -v ON_ERROR_STOP=1 <<'SQL'
SELECT to_regclass('echo_analytics.heartbeat')::text;
SQL
  )
  [[ "$heartbeat_table" == "$ANALYTICS_HEARTBEAT_SOURCE_SCHEMA.$ANALYTICS_HEARTBEAT_SOURCE_TABLE" ]] \
    || die "analytics heartbeat migration is not applied"
}

require_analytics_heartbeat_selected() {
  local expected="$ANALYTICS_HEARTBEAT_SOURCE_SCHEMA.$ANALYTICS_HEARTBEAT_SOURCE_TABLE"
  local table
  for table in "${SOURCE_TABLES[@]}"; do
    [[ "$table" == "$expected" ]] && return 0
  done
  die "the mandatory analytics heartbeat table is excluded: $expected"
}

sql_literal() {
  printf '%s' "$1" | sed "s/'/''/g"
}

psql_set_secret() {
  local name=$1
  local value=$2
  local encoded

  [[ "$name" =~ ^[a-z_][a-z0-9_]*$ ]] || die "invalid psql secret variable: $name"
  encoded=$(printf '%s' "$value" | base64 -w 0)
  printf '\\set %s %s\n' "$name" "$encoded"
}

xml_escape() {
  local value=$1
  value=${value//&/&amp;}
  value=${value//</&lt;}
  value=${value//>/&gt;}
  printf '%s' "$value"
}

toml_or_yaml_double_quote() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$value"
}

sed_replacement_escape() {
  printf '%s' "$1" | sed -e 's/[|&]/\\&/g'
}

validate_identifier() {
  local name=$1
  local value=$2
  [[ "$value" =~ ^[a-z_][a-z0-9_]*$ ]] || die "$name is not a safe unquoted identifier: $value"
}

validate_ipv4_address() {
  local name=$1
  local value=${2%/32}
  local octet
  [[ "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "$name is not an IPv4 address: $2"
  IFS=. read -r -a octets <<<"$value"
  for octet in "${octets[@]}"; do
    ((octet >= 0 && octet <= 255)) || die "$name is not an IPv4 address: $2"
  done
}

validate_runtime_identifiers() {
  local name
  for name in \
    SOURCE_DB SOURCE_USER SOURCE_PUBLICATION SOURCE_PEER \
    CATALOG_DB CATALOG_USER TEMPORAL_DB TEMPORAL_VISIBILITY_DB TEMPORAL_USER \
    GATEWAY_DB GATEWAY_USER CLICKHOUSE_RAW_DB CLICKHOUSE_CURRENT_DB \
    CLICKHOUSE_PEERDB_USER CLICKHOUSE_GATEWAY_USER CLICKHOUSE_PEER MIRROR_NAME
  do
    validate_identifier "$name" "${!name}"
  done
}

postgres_psql() {
  local psql_bin=/usr/lib/postgresql/$POSTGRESQL_MAJOR/bin/psql
  [[ -x "$psql_bin" ]] || die "missing PostgreSQL client: $psql_bin"
  if [[ $(id -u) -eq $(id -u postgres) ]]; then
    "$psql_bin" -X \
      --host /var/run/postgresql \
      --port "${ANALYTICS_GATEWAY_PORT:-5432}" \
      "$@"
  else
    sudo -u postgres "$psql_bin" -X \
      --host /var/run/postgresql \
      --port "${ANALYTICS_GATEWAY_PORT:-5432}" \
      "$@"
  fi
}

catalog_psql() {
  PGPASSWORD=$CATALOG_PASSWORD psql -X \
    --host 127.0.0.1 \
    --port "${ANALYTICS_GATEWAY_PORT:-5432}" \
    --username "$CATALOG_USER" \
    --dbname "$CATALOG_DB" \
    "$@"
}

source_psql() {
  PGPASSWORD=$SOURCE_PASSWORD psql -X \
    --host "$SOURCE_HOST" \
    --port "$SOURCE_PORT" \
    --username "$SOURCE_USER" \
    --dbname "$SOURCE_DB" \
    "$@"
}

gateway_psql() {
  PGPASSWORD=$GATEWAY_PASSWORD psql -X \
    --host 127.0.0.1 \
    --port "${ANALYTICS_GATEWAY_PORT:-5432}" \
    --username "$GATEWAY_USER" \
    --dbname "$GATEWAY_DB" \
    "$@"
}

peerdb_psql() {
  PGPASSWORD=$PEERDB_PASSWORD psql -X \
    --host 127.0.0.1 \
    --port "${PEERDB_PORT:-9900}" \
    --username peerdb \
    --dbname peerdb \
    "$@"
}

clickhouse_admin() {
  CLICKHOUSE_PASSWORD="$CLICKHOUSE_ADMIN_PASSWORD" clickhouse-client \
    --host 127.0.0.1 \
    --port "${CLICKHOUSE_NATIVE_PORT:-9000}" \
    --user default \
    "$@"
}

clickhouse_admin_http() {
  local query=$1 auth config response
  require_cmd base64
  require_cmd curl

  auth=$(printf 'default:%s' "$CLICKHOUSE_ADMIN_PASSWORD" | base64 -w 0)
  config=$(mktemp /tmp/echo-analytics-curl.XXXXXX)
  chmod 0600 "$config"
  printf 'header = "Authorization: Basic %s"\n' "$auth" >"$config"
  if ! response=$(printf '%s' "$query" | curl \
    --silent \
    --show-error \
    --fail-with-body \
    --connect-timeout 5 \
    --max-time 60 \
    --config "$config" \
    --data-binary @- \
    "http://127.0.0.1:${CLICKHOUSE_HTTP_PORT:-8123}/?default_format=TSVRaw"); then
    rm -f -- "$config"
    die "ClickHouse HTTP query failed"
  fi
  rm -f -- "$config"
  [[ -z "$response" ]] || printf '%s\n' "$response"
}

clickhouse_peerdb() {
  CLICKHOUSE_PASSWORD="$CLICKHOUSE_PEERDB_PASSWORD" clickhouse-client \
    --host 127.0.0.1 \
    --port "${CLICKHOUSE_NATIVE_PORT:-9000}" \
    --user "$CLICKHOUSE_PEERDB_USER" \
    "$@"
}

minio_mc_host() {
  local encoded_user encoded_password
  encoded_user=$(printf '%s' "$MINIO_ROOT_USER" | jq -Rr @uri)
  encoded_password=$(printf '%s' "$MINIO_ROOT_PASSWORD" | jq -Rr @uri)
  printf 'http://%s:%s@127.0.0.1:%s' \
    "$encoded_user" "$encoded_password" "${MINIO_API_PORT:-9002}"
}

wait_for_command() {
  local description=$1
  shift
  local attempt
  for attempt in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  die "timed out waiting for $description"
}

read_exclusions() {
  local exclude_file=$1
  declare -gA EXCLUDED_TABLE_LOOKUP=()
  protected_file_exists "$exclude_file" || return 0

  local raw table
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    table=$(printf '%s' "$raw" | sed -e 's/#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [[ -n "$table" ]] || continue
    [[ "$table" =~ ^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$ ]] \
      || die "invalid exclusion in $exclude_file: $table"
    EXCLUDED_TABLE_LOOKUP["$table"]=1
  done < <(read_protected_file "$exclude_file")
}

effective_source_exclude_file() {
  if protected_file_exists "$SOURCE_TABLE_EXCLUDE_FILE"; then
    printf '%s' "$SOURCE_TABLE_EXCLUDE_FILE"
  else
    printf '%s' "$DEFAULT_SOURCE_TABLE_EXCLUDE_FILE"
  fi
}

install_default_source_exclusions() {
  protected_file_exists "$SOURCE_TABLE_EXCLUDE_FILE" && return 0
  require_file "$DEFAULT_SOURCE_TABLE_EXCLUDE_FILE"
  sudo install -d -o root -g root -m 0755 \
    "$(dirname "$SOURCE_TABLE_EXCLUDE_FILE")"
  sudo install -o root -g root -m 0600 \
    "$DEFAULT_SOURCE_TABLE_EXCLUDE_FILE" "$SOURCE_TABLE_EXCLUDE_FILE"
  log "Installed the default table exclusions at $SOURCE_TABLE_EXCLUDE_FILE"
}

source_table_target() {
  local table=$1 schema relation target
  [[ "$table" =~ ^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$ ]] \
    || die "table requires quoted PeerDB mapping support: $table"
  schema=${table%%.*}
  relation=${table##*.}
  target=$relation
  [[ "$schema" == public ]] || target="${schema}__${relation}"
  validate_identifier target "$target"
  printf '%s' "$target"
}

selected_source_table_list() {
  local table_list
  table_list=$(printf '%s, ' "${SOURCE_TABLES[@]}")
  printf '%s' "${table_list%, }"
}

reconcile_source_table_access() {
  local table_list
  table_list=$(selected_source_table_list)

  log "Resetting the dedicated role to the selected table set"
  source_local_psql \
    -q \
    -v ON_ERROR_STOP=1 \
    -v source_user="$SOURCE_USER" \
    -v table_list="$table_list" <<'SQL'
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
}

reconcile_source_publication() {
  local table_list
  table_list=$(selected_source_table_list)

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
}

reset_excluded_replica_identities() {
  ((${#EXCLUDED_TABLE_LOOKUP[@]} > 0)) || return 0
  local excluded_csv
  excluded_csv=$(printf '%s,' "${!EXCLUDED_TABLE_LOOKUP[@]}")
  excluded_csv=${excluded_csv%,}

  log "Resetting excluded tables that still use REPLICA IDENTITY FULL"
  source_local_psql \
    -q \
    -v ON_ERROR_STOP=1 \
    -v excluded_csv="$excluded_csv" <<'SQL'
SELECT format('ALTER TABLE %I.%I REPLICA IDENTITY DEFAULT', n.nspname, c.relname)
FROM unnest(string_to_array(:'excluded_csv', ',')) excluded(table_name)
JOIN pg_class c ON c.oid = to_regclass(excluded.table_name)
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relreplident = 'f'
\gexec
SQL
}

read_source_tables() {
  declare -ga SOURCE_TABLES=()

  local table
  while IFS= read -r table; do
    [[ -n "$table" ]] || continue
    [[ "$table" =~ ^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$ ]] \
      || die "table requires quoted PeerDB mapping support: $table"
    SOURCE_TABLES+=("$table")
  done < <(
    source_psql -Atq -v ON_ERROR_STOP=1 \
      -v publication="$SOURCE_PUBLICATION" <<'SQL'
SELECT schemaname || '.' || tablename
FROM pg_catalog.pg_publication_tables
WHERE pubname = :'publication'
ORDER BY schemaname, tablename;
SQL
  )

  ((${#SOURCE_TABLES[@]} > 0)) \
    || die "source publication has no tables: $SOURCE_PUBLICATION"
}

ensure_yes() {
  local answer=${1:-}
  [[ "$answer" == "--yes" ]] || die "destructive operation requires --yes"
}
