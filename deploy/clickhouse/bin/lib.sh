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
SOURCE_TABLE_EXCLUDE_REPO_FILE=$BUNDLE_DIR/env/tables-exclude.txt
SOURCE_RECONCILE_STATE_DIR=${ECHO_PEERDB_RECONCILE_STATE_DIR:-/var/lib/echo-peerdb}
SOURCE_RECONCILE_FINGERPRINT_FILE=$SOURCE_RECONCILE_STATE_DIR/table-selection.sha256
SOURCE_RECONCILE_LOCK_FILE=$SOURCE_RECONCILE_STATE_DIR/table-selection.lock
SOURCE_RECONCILE_DDL_LOCK_TIMEOUT=2s
ANALYTICS_RECONCILE_STATE_DIR=${ECHO_ANALYTICS_RECONCILE_STATE_DIR:-/var/lib/echo-analytics/reconcile}
# shellcheck disable=SC2034
ANALYTICS_RECONCILE_STATE_FILE=$ANALYTICS_RECONCILE_STATE_DIR/desired-state-id
ANALYTICS_RECONCILE_LOCK_FILE=${ECHO_ANALYTICS_RECONCILE_LOCK_FILE:-/run/lock/echo-analytics-reconcile.lock}
# shellcheck disable=SC2034
SOURCE_RECONCILE_DEPLOY_RETRY_ATTEMPTS_DEFAULT=5
# shellcheck disable=SC2034
SOURCE_RECONCILE_DEPLOY_RETRY_DELAY_SECONDS_DEFAULT=30
# shellcheck disable=SC2034
ANALYTICS_SCHEMA_PROPAGATION_RETRY_ATTEMPTS_DEFAULT=30
# shellcheck disable=SC2034
ANALYTICS_SCHEMA_PROPAGATION_RETRY_DELAY_SECONDS_DEFAULT=10
# shellcheck disable=SC2034
ANALYTICS_SCHEMA_PROPAGATION_RETRY_TIMEOUT_SECONDS_DEFAULT=300
# shellcheck disable=SC2034
ANALYTICS_SCHEMA_RECONCILE_LOCK_NAME=echo_analytics_schema_reconciliation
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

reconcile_analytics_schema_with_retry() {
  local analytics_bin_dir=$1
  local attempts=${MIRROR_TABLE_RECONCILE_SCHEMA_RETRY_ATTEMPTS:-$ANALYTICS_SCHEMA_PROPAGATION_RETRY_ATTEMPTS_DEFAULT}
  local delay=${MIRROR_TABLE_RECONCILE_SCHEMA_RETRY_DELAY_SECONDS:-$ANALYTICS_SCHEMA_PROPAGATION_RETRY_DELAY_SECONDS_DEFAULT}
  local timeout=${MIRROR_TABLE_RECONCILE_SCHEMA_RETRY_TIMEOUT_SECONDS:-$ANALYTICS_SCHEMA_PROPAGATION_RETRY_TIMEOUT_SECONDS_DEFAULT}
  local attempt status deadline

  [[ "$attempts" =~ ^[1-9][0-9]*$ ]] \
    || die "MIRROR_TABLE_RECONCILE_SCHEMA_RETRY_ATTEMPTS must be a positive integer"
  [[ "$delay" =~ ^[0-9]+$ ]] \
    || die "MIRROR_TABLE_RECONCILE_SCHEMA_RETRY_DELAY_SECONDS must be a non-negative integer"
  [[ "$timeout" =~ ^[1-9][0-9]*$ ]] \
    || die "MIRROR_TABLE_RECONCILE_SCHEMA_RETRY_TIMEOUT_SECONDS must be a positive integer"

  deadline=$((SECONDS + timeout))
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    status=0
    "$analytics_bin_dir/refresh-current-views.sh" \
      && "$analytics_bin_dir/refresh-gateway.sh" \
      && "$analytics_bin_dir/reconcile-schema.sh" \
      && "$analytics_bin_dir/check-analytics-health.sh" \
      || status=$?
    ((status != 0)) || return 0
    ((attempt < attempts && SECONDS < deadline)) || return "$status"
    log "Analytics schema propagation is not stable; retrying in ${delay}s ($attempt/$attempts)"
    sleep "$delay"
  done
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
  local table
  while IFS= read -r table; do
    [[ -n "$table" ]] || continue
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

  ((${#SOURCE_TABLES[@]} > 0)) || die "no source tables selected"
}

source_table_selection_fingerprint() {
  require_cmd awk
  require_cmd sha256sum
  printf '%s\n' "${SOURCE_TABLES[@]}" | sha256sum | awk '{print $1}'
}

source_publication_fingerprint() {
  require_cmd awk
  require_cmd sha256sum
  source_local_psql -Atq -v ON_ERROR_STOP=1 \
    -v publication="$SOURCE_PUBLICATION" <<'SQL' \
    | sha256sum | awk '{print $1}'
SELECT schemaname || '.' || tablename
FROM pg_catalog.pg_publication_tables
WHERE pubname = :'publication'
ORDER BY schemaname, tablename;
SQL
}

ensure_source_reconcile_state_dir() {
  [[ -d "$SOURCE_RECONCILE_STATE_DIR" ]] && return 0
  sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0750 \
    "$SOURCE_RECONCILE_STATE_DIR"
}

acquire_source_reconcile_lock() {
  local wait_seconds=${SOURCE_RECONCILE_LOCK_WAIT_SECONDS:-0}
  [[ "$wait_seconds" =~ ^[0-9]+$ ]] \
    || die "SOURCE_RECONCILE_LOCK_WAIT_SECONDS must be a non-negative integer"
  require_cmd flock
  ensure_source_reconcile_state_dir
  exec 9>"$SOURCE_RECONCILE_LOCK_FILE"
  if ((wait_seconds > 0)); then
    flock -w "$wait_seconds" 9 \
      || die "table-selection reconciliation lock was not available within ${wait_seconds}s"
  else
    if ! flock -n 9; then
      if [[ ${SOURCE_RECONCILE_LOCK_BUSY_IS_SUCCESS:-false} == true ]]; then
        log "Another table-selection reconciliation owns the lock; skipping this timer run"
        exit 0
      fi
      die "another table-selection reconciliation is already running"
    fi
  fi
  export ECHO_PEERDB_RECONCILE_LOCK_HELD=true
}

acquire_analytics_reconcile_lock() {
  if [[ ${ECHO_ANALYTICS_RECONCILE_LOCK_HELD:-false} == true \
    && -e /proc/$$/fd/8 ]]; then
    return 0
  fi

  local old_umask wait_seconds=${ANALYTICS_RECONCILE_LOCK_WAIT_SECONDS:-300}
  [[ "$wait_seconds" =~ ^[0-9]+$ ]] \
    || die "ANALYTICS_RECONCILE_LOCK_WAIT_SECONDS must be a non-negative integer"
  require_cmd flock
  old_umask=$(umask)
  umask 000
  : >>"$ANALYTICS_RECONCILE_LOCK_FILE"
  umask "$old_umask"
  exec 8>>"$ANALYTICS_RECONCILE_LOCK_FILE"
  flock -w "$wait_seconds" 8 \
    || die "analytics reconciliation lock was not available within ${wait_seconds}s"
  export ECHO_ANALYTICS_RECONCILE_LOCK_HELD=true
}

control_bundle_release_id() {
  local bundle_dir=$1 relative_path digest
  require_cmd find
  require_cmd sha256sum
  require_cmd sort
  require_cmd awk
  validate_control_bundle "$bundle_dir"

  while IFS= read -r -d '' relative_path; do
    digest=$(sha256sum "$bundle_dir/$relative_path" | awk '{print $1}')
    printf '%s  %s\n' "$digest" "$relative_path"
  done < <(control_bundle_file_list "$bundle_dir") \
    | sha256sum | awk '{print $1}'
}

validate_control_bundle() {
  local bundle_dir=$1 relative_path
  local -a files=(
    control-protocol-version
    env/tables-exclude.txt
    migration-impact.json
    versions.env
  )
  local -a directories=(bin shims source-systemd systemd)

  for relative_path in "${files[@]}"; do
    require_file "$bundle_dir/$relative_path"
  done
  for relative_path in "${directories[@]}"; do
    [[ -d "$bundle_dir/$relative_path" ]] \
      || die "missing control bundle directory: $bundle_dir/$relative_path"
  done
  [[ $(tr -d '\r\n' <"$bundle_dir/control-protocol-version") == 1 ]] \
    || die "unsupported analytics control protocol version"
}

control_bundle_file_list() {
  local bundle_dir=$1 relative_path
  local -a files=(
    control-protocol-version
    env/tables-exclude.txt
    migration-impact.json
    versions.env
  )
  local -a directories=(bin shims source-systemd systemd)

  {
    for relative_path in "${files[@]}"; do
      printf '%s\0' "$relative_path"
    done
    for relative_path in "${directories[@]}"; do
      find "$bundle_dir/$relative_path" -type f -printf '%P\0' \
        | while IFS= read -r -d '' child_path; do
            printf '%s/%s\0' "$relative_path" "$child_path"
          done
    done
  } | LC_ALL=C sort -z
}

archive_control_bundle() {
  local bundle_dir=$1
  validate_control_bundle "$bundle_dir"
  tar -C "$bundle_dir" \
    --null \
    --files-from=<(control_bundle_file_list "$bundle_dir") \
    --create \
    --file=-
}

normalize_control_release_permissions() {
  local release_dir=$1
  find "$release_dir" -type d -exec chmod 0755 {} +
  find "$release_dir/bin" "$release_dir/shims" -type f -exec chmod 0755 {} +
  find "$release_dir/env" "$release_dir/source-systemd" "$release_dir/systemd" \
    -type f -exec chmod 0644 {} +
  chmod 0644 \
    "$release_dir/control-protocol-version" \
    "$release_dir/migration-impact.json" \
    "$release_dir/versions.env"
}

active_control_release_id() {
  require_file "$BUNDLE_DIR/release-id"
  local release_id
  release_id=$(tr -d '\r\n' <"$BUNDLE_DIR/release-id")
  [[ "$release_id" =~ ^[a-f0-9]{64}$ ]] \
    || die "invalid active analytics control release id: $release_id"
  printf '%s\n' "$release_id"
}

analytics_desired_state_id() {
  local release_id raw_table_state
  release_id=$(active_control_release_id)
  raw_table_state=$(clickhouse_admin_http "
    SELECT concat(name, '=', toString(uuid))
    FROM system.tables
    WHERE database = '$CLICKHOUSE_RAW_DB'
      AND name IN (
        'sigint_inbox_item',
        'signal_message',
        'signal_message_group',
        'sigint_inbox_item_tag',
        'sigint_inbox_item_network'
      )
    ORDER BY name
  ")
  printf '%s\n%s\n' "$release_id" "$raw_table_state" \
    | sha256sum | awk '{print $1}'
}

current_control_release_id() {
  if [[ -f "$BUNDLE_DIR/release-id" ]]; then
    active_control_release_id
  else
    control_bundle_release_id "$BUNDLE_DIR"
  fi
}

require_paired_control_release() {
  local analytics_ssh_target=$1 expected actual
  expected=$(current_control_release_id)
  actual=$(ssh -n \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    "$analytics_ssh_target" \
    'cat /opt/echo-analytics/current/release-id' 2>/dev/null || true)
  [[ "$actual" == "$expected" ]] \
    || die "paired analytics control release mismatch: source $expected, analytics ${actual:-missing}"
  printf '%s\n' "$expected"
}

require_expected_control_release() {
  local expected=${ECHO_ANALYTICS_EXPECTED_CONTROL_RELEASE:-}
  [[ -n "$expected" ]] || return 0

  local active
  active=$(active_control_release_id)
  [[ "$active" == "$expected" ]] \
    || die "analytics control release mismatch: expected $expected, active $active"
}

delegate_paired_analytics_operation_if_source() {
  local operation=$1
  shift
  protected_file_exists "$SOURCE_CONFIG_FILE" || return 0
  [[ "$operation" == resync.sh || "$operation" == finish-resync.sh ]] \
    || die "unsupported paired analytics operation: $operation"
  if (($# > 0)); then
    [[ $# -eq 1 && $1 == --yes ]] \
      || die "unsupported arguments for paired analytics operation: $*"
  fi

  load_source_config
  local analytics_ssh_target control_release remote_argument=
  analytics_ssh_target=${ANALYTICS_SSH_TARGET:-echo@${ANALYTICS_ADDRESS%/*}}
  [[ "$analytics_ssh_target" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ ]] \
    || die "invalid ANALYTICS_SSH_TARGET: $analytics_ssh_target"
  control_release=$(require_paired_control_release "$analytics_ssh_target")
  (($# == 0)) || remote_argument=" $1"
  ssh -n \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    "$analytics_ssh_target" \
    "sudo -n env ECHO_ANALYTICS_EXPECTED_CONTROL_RELEASE=$control_release /opt/echo-analytics/current/bin/$operation$remote_argument"
  exit 0
}

record_source_table_selection_fingerprint() {
  local fingerprint temporary_file
  fingerprint=$(source_table_selection_fingerprint)
  ensure_source_reconcile_state_dir
  temporary_file=$(mktemp "$SOURCE_RECONCILE_STATE_DIR/.table-selection.XXXXXX")
  printf '%s\n' "$fingerprint" >"$temporary_file"
  chmod 0600 "$temporary_file"
  mv -f -- "$temporary_file" "$SOURCE_RECONCILE_FINGERPRINT_FILE"
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

print_analytics_schema_reconcile_lock_sql() {
  cat <<'SQL'
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(:'schema_reconcile_lock_name', 0)
) AS schema_reconcile_lock_acquired
\gset
SQL
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

normalized_exclusions() {
  local exclude_file=$1
  read_exclusions "$exclude_file"
  if ((${#EXCLUDED_TABLE_LOOKUP[@]} > 0)); then
    printf '%s\n' "${!EXCLUDED_TABLE_LOOKUP[@]}" | LC_ALL=C sort
  fi
}

source_exclusions_match() {
  local first=$1 second=$2
  diff -q \
    <(normalized_exclusions "$first") \
    <(normalized_exclusions "$second") \
    >/dev/null
}

effective_source_exclude_file() {
  if protected_file_exists "$SOURCE_TABLE_EXCLUDE_FILE"; then
    printf '%s' "$SOURCE_TABLE_EXCLUDE_FILE"
  else
    printf '%s' "$SOURCE_TABLE_EXCLUDE_REPO_FILE"
  fi
}

install_default_source_exclusions() {
  protected_file_exists "$SOURCE_TABLE_EXCLUDE_FILE" && return 0
  require_file "$SOURCE_TABLE_EXCLUDE_REPO_FILE"
  sudo install -d -o root -g root -m 0755 \
    "$(dirname "$SOURCE_TABLE_EXCLUDE_FILE")"
  sudo install -o root -g root -m 0600 \
    "$SOURCE_TABLE_EXCLUDE_REPO_FILE" "$SOURCE_TABLE_EXCLUDE_FILE"
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
    -v table_list="$table_list" \
    -v ddl_lock_timeout="$SOURCE_RECONCILE_DDL_LOCK_TIMEOUT" <<'SQL'
SELECT set_config('lock_timeout', :'ddl_lock_timeout', false);

SELECT CASE
  WHEN EXISTS (SELECT FROM pg_publication WHERE pubname = :'publication')
    THEN format('ALTER PUBLICATION %I SET TABLE %s', :'publication', :'table_list')
  ELSE format('CREATE PUBLICATION %I FOR TABLE %s', :'publication', :'table_list')
END \gexec

SELECT format(
  'ALTER PUBLICATION %I SET (publish_generated_columns = stored)',
  :'publication'
) \gexec

SELECT format(
  'ALTER TABLE %I.%I REPLICA IDENTITY FULL',
  publication_table.schemaname,
  publication_table.tablename
)
FROM pg_publication_tables publication_table
JOIN pg_namespace namespace
  ON namespace.nspname = publication_table.schemaname
JOIN pg_class relation
  ON relation.relnamespace = namespace.oid
  AND relation.relname = publication_table.tablename
WHERE publication_table.pubname = :'publication'
  AND relation.relkind IN ('r', 'p')
  AND relation.relreplident <> 'f'
\gexec
SQL
}

ensure_source_publication_generated_columns() {
  [[ "$SOURCE_PG_MAJOR" =~ ^[0-9]+$ ]] \
    || die "SOURCE_PG_MAJOR must be numeric"
  ((SOURCE_PG_MAJOR >= 18)) || return 0

  local generated_columns
  generated_columns=$(source_local_psql \
    -Atq \
    -v ON_ERROR_STOP=1 \
    -v publication="$SOURCE_PUBLICATION" <<'SQL'
SELECT pubgencols
FROM pg_publication
WHERE pubname = :'publication';
SQL
  )
  [[ "$generated_columns" == s ]] || {
    log "Enabling stored generated columns in publication $SOURCE_PUBLICATION"
    source_local_psql \
      -q \
      -v ON_ERROR_STOP=1 \
      -v publication="$SOURCE_PUBLICATION" <<'SQL'
SELECT format(
  'ALTER PUBLICATION %I SET (publish_generated_columns = stored)',
  :'publication'
) \gexec
SQL
  }
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
