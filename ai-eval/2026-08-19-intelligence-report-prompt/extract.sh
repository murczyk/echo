#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
eval_dir="$repo_root/ai-eval/2026-08-19-intelligence-report-prompt"
raw_dir="$eval_dir/raw"
snapshot="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
allow_large=false
max_rows=750000
max_bytes=2147483648

while (($#)); do
  case "$1" in
    --snapshot)
      snapshot="${2:?--snapshot requires a value}"
      shift 2
      ;;
    --allow-large)
      allow_large=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$(date -u -d "$snapshot" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" != "$snapshot" ]]; then
  echo "Snapshot must use UTC second precision: YYYY-MM-DDTHH:MM:SSZ" >&2
  exit 1
fi
command -v ssh >/dev/null
command -v zstd >/dev/null
mkdir -p "$raw_dir"
extract_tmp_dir="$(mktemp -d)"
trap 'rm -rf "$extract_tmp_dir"' EXIT

decode_copy_hex() {
  python3 -c 'import sys
for line in sys.stdin.buffer:
    sys.stdout.buffer.write(bytes.fromhex(line.decode().strip()) + b"\n")'
}

preflight_pairs() {
  local server="$1"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$server" \
    "sudo -n -u postgres psql -X -qAt -F '|' -v ON_ERROR_STOP=1 -v snapshot='$snapshot' -d wd" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL application_name = 'echo_ai_eval_3093_pairs_preflight';
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
WITH pairs AS (
    SELECT DISTINCT ON (
        md5(coalesce(sii.body_noheader->>'body', sm.body, '')),
        lower(trim(comment.comment))
    )
        coalesce(sii.body_noheader->>'body', sm.body, '') AS source,
        trim(comment.comment) AS report
    FROM sigint_comment AS comment
    INNER JOIN login AS author ON author.id = comment.login_id
    INNER JOIN signal_message AS sm ON sm.id = comment.signal_message_id
    LEFT JOIN sigint_inbox_item AS sii ON sii.id = sm.id
    LEFT JOIN sigint_comment_blacklist AS blacklist
        ON lower(trim(blacklist.text)) = lower(trim(comment.comment))
    WHERE comment.created_at < :'snapshot'::timestamptz AT TIME ZONE 'UTC'
      AND author.login <> 'system'
      AND NOT author.deleted
      AND NOT author.deleted_permanently
      AND NOT sm.deleted
      AND trim(comment.comment) <> ''
      AND coalesce(sii.body_noheader->>'body', sm.body, '') <> ''
      AND blacklist.text IS NULL
    ORDER BY
        md5(coalesce(sii.body_noheader->>'body', sm.body, '')),
        lower(trim(comment.comment)),
        comment.created_at,
        comment.id
)
SELECT count(*),
       coalesce(sum(octet_length(source) + octet_length(report)), 0)
FROM pairs;
COMMIT;
SQL
}

extract_pairs() {
  local server="$1"
  local dataset="$2"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$server" \
    "sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1 -v snapshot='$snapshot' -v dataset='$dataset' -d wd" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL application_name = 'echo_ai_eval_3093_pairs_export';
SET LOCAL statement_timeout = '15min';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '15min';
COPY (
    WITH pairs AS (
        SELECT DISTINCT ON (
            md5(coalesce(sii.body_noheader->>'body', sm.body, '')),
            lower(trim(comment.comment))
        )
            sm.id AS source_message_id,
            md5(comment.login_id::text) AS author_key,
            coalesce(dg.group_master_key, linked_group.group_master_key) AS group_key,
            sii.freq,
            coalesce(sm.timestamp, sm.created_at) AS message_at,
            comment.created_at AS report_at,
            coalesce(sii.body_noheader->>'body', sm.body, '') AS source,
            trim(comment.comment) AS report
        FROM sigint_comment AS comment
        INNER JOIN login AS author ON author.id = comment.login_id
        INNER JOIN signal_message AS sm ON sm.id = comment.signal_message_id
        LEFT JOIN sigint_inbox_item AS sii ON sii.id = sm.id
        LEFT JOIN datasource_group AS dg ON dg.id = sm.datasource_group_id
        LEFT JOIN LATERAL (
            SELECT smg.group_master_key
            FROM signal_message_group AS smg
            WHERE smg.signal_message_id = sm.id
            ORDER BY smg.group_master_key
            LIMIT 1
        ) AS linked_group ON true
        LEFT JOIN sigint_comment_blacklist AS blacklist
            ON lower(trim(blacklist.text)) = lower(trim(comment.comment))
        WHERE comment.created_at < :'snapshot'::timestamptz AT TIME ZONE 'UTC'
          AND author.login <> 'system'
          AND NOT author.deleted
          AND NOT author.deleted_permanently
          AND NOT sm.deleted
          AND trim(comment.comment) <> ''
          AND coalesce(sii.body_noheader->>'body', sm.body, '') <> ''
          AND blacklist.text IS NULL
        ORDER BY
            md5(coalesce(sii.body_noheader->>'body', sm.body, '')),
            lower(trim(comment.comment)),
            comment.created_at,
            comment.id
    )
    SELECT encode(convert_to(jsonb_build_object(
        'dataset', :'dataset',
        'sourceMessageId', source_message_id,
        'authorKey', author_key,
        'groupKey', group_key,
        'frequency', freq,
        'messageAt', to_char(message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'reportAt', to_char(report_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'source', source,
        'report', report
    )::text, 'UTF8'), 'hex')
    FROM pairs
    ORDER BY report_at, source_message_id
) TO STDOUT;
COMMIT;
SQL
}

preflight_goi() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 echo-pivnich \
    "sudo -n -u postgres psql -X -qAt -F '|' -v ON_ERROR_STOP=1 -v snapshot='$snapshot' -d wd" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL application_name = 'echo_ai_eval_3093_goi_preflight';
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
WITH pairs AS (
    SELECT DISTINCT ON (association.integration_id, association.source_association_id)
        coalesce(inbox.body_noheader->>'body', message.body, '') AS source,
        trim(association.note) AS report
    FROM goi_association AS association
    INNER JOIN signal_message AS message
        ON message.message_uid = association.message_uid
    LEFT JOIN sigint_inbox_item AS inbox ON inbox.id = message.id
    WHERE NOT association.deleted
      AND NOT message.deleted
      AND association.message_uid IS NOT NULL
      AND trim(coalesce(association.note, '')) <> ''
      AND coalesce(inbox.body_noheader->>'body', message.body, '') <> ''
      AND association.created_at < :'snapshot'::timestamptz
    ORDER BY association.integration_id, association.source_association_id,
             association.created_at
)
SELECT count(*),
       coalesce(sum(octet_length(source) + octet_length(report)), 0)
FROM pairs;
COMMIT;
SQL
}

extract_goi() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 echo-pivnich \
    "sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1 -v snapshot='$snapshot' -d wd" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL application_name = 'echo_ai_eval_3093_goi_export';
SET LOCAL statement_timeout = '15min';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '15min';
COPY (
    WITH pairs AS (
        SELECT DISTINCT ON (association.integration_id, association.source_association_id)
            message.id AS source_message_id,
            md5(coalesce(association.author, 'unknown')) AS author_key,
            coalesce(dg.group_master_key, linked_group.group_master_key) AS group_key,
            inbox.freq,
            coalesce(message.timestamp, message.created_at) AS message_at,
            association.created_at AS report_at,
            coalesce(inbox.body_noheader->>'body', message.body, '') AS source,
            trim(association.note) AS report
        FROM goi_association AS association
        INNER JOIN signal_message AS message
            ON message.message_uid = association.message_uid
        LEFT JOIN sigint_inbox_item AS inbox ON inbox.id = message.id
        LEFT JOIN datasource_group AS dg ON dg.id = message.datasource_group_id
        LEFT JOIN LATERAL (
            SELECT smg.group_master_key
            FROM signal_message_group AS smg
            WHERE smg.signal_message_id = message.id
            ORDER BY smg.group_master_key
            LIMIT 1
        ) AS linked_group ON true
        WHERE NOT association.deleted
          AND NOT message.deleted
          AND association.message_uid IS NOT NULL
          AND trim(coalesce(association.note, '')) <> ''
          AND coalesce(inbox.body_noheader->>'body', message.body, '') <> ''
          AND association.created_at < :'snapshot'::timestamptz
        ORDER BY association.integration_id, association.source_association_id,
                 association.created_at
    )
    SELECT encode(convert_to(jsonb_build_object(
        'dataset', 'linked-goi',
        'sourceMessageId', source_message_id,
        'authorKey', author_key,
        'groupKey', group_key,
        'frequency', freq,
        'messageAt', to_char(message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'reportAt', to_char(report_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'source', source,
        'report', report
    )::text, 'UTF8'), 'hex')
    FROM pairs
    ORDER BY report_at, source_message_id
) TO STDOUT;
COMMIT;
SQL
}

check_size() {
  local name="$1"
  local row="$2"
  local rows bytes
  IFS='|' read -r rows bytes <<<"$row"
  [[ "$rows" =~ ^[0-9]+$ && "$bytes" =~ ^[0-9]+$ ]] || {
    echo "$name returned invalid preflight values" >&2
    exit 1
  }
  echo "$name: projected rows=$rows selected_bytes=$bytes" >&2
  if ! $allow_large && ((rows > max_rows || bytes > max_bytes)); then
    echo "$name exceeds the safety limit; inspect it and rerun with --allow-large" >&2
    exit 1
  fi
}

for source_spec in "echo-cbr:cbr" "echo-pivnich:pivnich"; do
  server="${source_spec%%:*}"
  dataset="${source_spec##*:}"
  check_size "$dataset" "$(preflight_pairs "$server")"
done
check_size "linked-goi" "$(preflight_goi)"

for source_spec in "echo-cbr:cbr" "echo-pivnich:pivnich"; do
  server="${source_spec%%:*}"
  dataset="${source_spec##*:}"
  output="$extract_tmp_dir/$dataset-human-pairs.jsonl.zst"
  extract_pairs "$server" "$dataset" | decode_copy_hex | zstd -q -T0 -10 -o "$output"
  mv "$output" "$raw_dir/$dataset-human-pairs.jsonl.zst"
done
goi_output="$extract_tmp_dir/pivnich-linked-goi.jsonl.zst"
extract_goi | decode_copy_hex | zstd -q -T0 -10 -o "$goi_output"
mv "$goi_output" "$raw_dir/pivnich-linked-goi.jsonl.zst"

sha256sum "$raw_dir"/*.jsonl.zst
