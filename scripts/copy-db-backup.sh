#!/usr/bin/env bash
set -euxo pipefail

usage() {
    cat <<'USAGE'
Usage: copy-db-backup.sh <server>

Environment variables:
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  Backblaze S3 access
  ENDPOINT_URL                             Override S3 endpoint
  BUCKET_PREFIX                            Override S3 bucket prefix
USAGE
}

die() {
    echo "ERROR: $1" >&2
    exit 1
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

server="${1:-${SERVER:-}}"
endpoint_url="${ENDPOINT_URL:-https://s3.eu-central-003.backblazeb2.com}"
bucket_prefix="${BUCKET_PREFIX:-s3://echouabackup/backup/echo}"

if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
    die "Please export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for Backblaze S3 access"
fi

if [[ -z "$server" ]]; then
    usage
    die "server parameter is required, e.g. echo-zp2"
fi

require_cmd s5cmd
require_cmd gpg

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
gpg --output "$local_plain" --decrypt "$local_encrypted"

cat <<EOF

Restore locally:
  sudo -u postgres dropdb --force wd
  sudo -u postgres psql postgres -c "CREATE DATABASE wd"
  sudo -u postgres pg_restore -d wd $local_plain

Restore on dev machine:
  scp $local_plain DEV_HOST:/var/tmp/
  ssh DEV_HOST "sudo -u postgres dropdb --force wd && sudo -u postgres psql postgres -c \"CREATE DATABASE wd\" && sudo -u postgres pg_restore -d wd /var/tmp/${local_plain_basename}"

You can disable messengers by running:
  cargo run -p wdintel-rs -- --mode=debug oneoff-disable-im
EOF
