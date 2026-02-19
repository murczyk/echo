#!/usr/bin/env bash
set -euxo pipefail

usage() {
    cat <<'USAGE'
Usage: copy-db-backup.sh <server>
       copy-db-backup.sh <server> --restore [--restore-db=<db>]
       copy-db-backup.sh --restore --restore-db <db> <server>

Environment variables:
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  Backblaze S3 access
  ENDPOINT_URL                             Override S3 endpoint
  BUCKET_PREFIX                            Override S3 bucket prefix
  GPG_PASSPHRASE                           Preset gpg-agent passphrase
  GPG_KEYGRIP                              Optional gpg keygrip to preset
  RESTORE_DB                               Default restore database name
USAGE
}

die() {
    echo "ERROR: $1" >&2
    exit 1
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

ensure_gpg_agent_conf_line() {
    local gnupg_home="${GNUPGHOME:-$HOME/.gnupg}"
    local gpg_agent_conf="${gnupg_home}/gpg-agent.conf"

    mkdir -p "$gnupg_home"
    if [[ ! -f "$gpg_agent_conf" ]] || ! grep -Fxq "$1" "$gpg_agent_conf"; then
        printf '%s\n' "$1" >> "$gpg_agent_conf"
    fi
}

preset_gpg_passphrase() {
    local passphrase="$1"
    local keygrip="${GPG_KEYGRIP:-}"

    ensure_gpg_agent_conf_line "allow-preset-passphrase"
    if command -v gpgconf >/dev/null 2>&1; then
        gpgconf --reload gpg-agent || true
    fi

    require_cmd gpg-preset-passphrase

    if [[ -z "$keygrip" ]]; then
        keygrip=$(gpg --list-secret-keys --with-keygrip 2>/dev/null | awk '/Keygrip/ {print $3; exit}')
    fi
    if [[ -z "$keygrip" ]]; then
        die "Could not determine GPG keygrip for preset-passphrase"
    fi

	set +x
    gpg-preset-passphrase --preset --passphrase "$passphrase" "$keygrip"
	set -x
}

server="${SERVER:-}"
restore_db="${RESTORE_DB:-}"
do_restore=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --restore)
            do_restore=1
            ;;
        --restore-db=*)
            restore_db="${1#*=}"
            ;;
        --restore-db)
            shift
            if [[ -z "${1:-}" ]]; then
                die "--restore-db requires a value"
            fi
            restore_db="$1"
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        --)
            shift
            break
            ;;
        -*)
            die "Unknown option: $1"
            ;;
        *)
            if [[ -z "$server" ]]; then
                server="$1"
            else
                die "Unexpected argument: $1"
            fi
            ;;
    esac
    shift
done

endpoint_url="${ENDPOINT_URL:-https://s3.eu-central-003.backblazeb2.com}"
bucket_prefix="${BUCKET_PREFIX:-s3://echouabackup/backup/echo}"
gpg_use_loopback=0

set +x
if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
    die "Please export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for Backblaze S3 access"
fi

if [[ -z "$server" ]]; then
    usage
    die "server parameter is required, e.g. echo-zp2"
fi
set -x

require_cmd s5cmd
require_cmd gpg

set +x
if [[ -n "${GPG_PASSPHRASE:-}" ]]; then
	set -x
    if command -v gpg-preset-passphrase >/dev/null 2>&1; then
        preset_gpg_passphrase "$GPG_PASSPHRASE"
    else
        ensure_gpg_agent_conf_line "allow-loopback-pinentry"
        if command -v gpgconf >/dev/null 2>&1; then
            gpgconf --reload gpg-agent || true
        fi
        gpg_use_loopback=1
        echo "WARN: gpg-preset-passphrase not found; using loopback passphrase mode"
    fi
fi
set -x

printf 'Looking up latest backup directory in %s/ ...\n' "$bucket_prefix"
latest_date=$(
    s5cmd --endpoint-url "$endpoint_url" ls "${bucket_prefix}/" \
    | awk '/DIR/ {gsub(/\/$/,"",$NF); print $NF}' \
    | sort \
    | tail -n 1
)

if [[ -z "$latest_date" ]]; then
    die "No backup directories found in ${bucket_prefix}/"
fi

remote_dir="${bucket_prefix}/${latest_date}/"
printf 'Latest backup date: %s\n' "$latest_date"

listing=$(s5cmd --endpoint-url "$endpoint_url" ls "$remote_dir")
server_norm="${server#echo-}"
match=$(
    printf '%s\n' "$listing" \
    | awk -v srv="$server" -v srv_norm="$server_norm" '
        $0 ~ ("wd-" srv "\\.") || $0 ~ ("wd-" srv_norm "\\.") {print $NF}' \
    | sort \
    | tail -n 1
)

if [[ -z "$match" ]]; then
    die "No backup found for server '${server}' under ${remote_dir}"
fi

remote_file="${remote_dir}${match}"
local_encrypted="/var/tmp/${match}"
local_plain="${local_encrypted%.gpg}"
local_plain_basename=$(basename "$local_plain")

printf 'Downloading %s to %s\n' "$remote_file" "$local_encrypted"
s5cmd --endpoint-url "$endpoint_url" cp --show-progress "$remote_file" "$local_encrypted"

printf 'Decrypting to %s\n' "$local_plain"
if [[ "$gpg_use_loopback" -eq 1 ]]; then
	set +x
    gpg --batch --yes --pinentry-mode loopback --passphrase "$GPG_PASSPHRASE" --output "$local_plain" --decrypt "$local_encrypted"
	set -x
else
    gpg --output "$local_plain" --decrypt "$local_encrypted"
fi

printf 'DUMP_PATH: %s\n' "$local_plain"
restore_db_print="${restore_db:-wd}"
if [[ "$do_restore" -eq 1 ]]; then
    restore_db="${restore_db_print}"
    printf 'Restoring database: %s\n' "$restore_db"
    sudo -u postgres dropdb --if-exists --force "$restore_db"
    sudo -u postgres psql postgres -c "CREATE DATABASE ${restore_db}"
    sudo -u postgres pg_restore -d "$restore_db" "$local_plain"
fi
cat <<EOF

Restore locally:
  sudo -u postgres dropdb --if-exists --force ${restore_db_print}
  sudo -u postgres psql postgres -c "CREATE DATABASE ${restore_db_print}"
  sudo -u postgres pg_restore -d ${restore_db_print} $local_plain

Restore on dev machine:
  scp $local_plain DEV_HOST:/var/tmp/
  ssh DEV_HOST "sudo -u postgres dropdb --if-exists --force ${restore_db_print} && sudo -u postgres psql postgres -c \"CREATE DATABASE ${restore_db_print}\" && sudo -u postgres pg_restore -d ${restore_db_print} /var/tmp/${local_plain_basename}"

You can disable messengers by running:
  cargo run -p wdintel-rs -- --mode=debug oneoff-disable-im
EOF
