#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
eval_dir="$repo_root/ai-eval/2026-08-10-callsign-prompt"
raw_dir="$eval_dir/raw"
snapshot="${1:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}"
expected_prompt_md5="e28582ad0a1e6e07be76c95dd2f33cbf"
servers=(echo-siversk echo-zp2 echo-pivnich echo-skhid)
declare -A activation=(
  [echo-siversk]="2026-08-08T13:40:07.590253Z"
  [echo-zp2]="2026-08-08T15:46:12.896877Z"
  [echo-pivnich]="2026-08-08T17:35:58.393658Z"
  [echo-skhid]="2026-08-08T17:54:24.574648Z"
)

if [[ "$(date -u -d "$snapshot" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" != "$snapshot" ]]; then
  echo "Snapshot must use UTC second precision: YYYY-MM-DDTHH:MM:SSZ" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$raw_dir"

preflight_server() {
  local server="$1"
  local row
  row="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$server" \
    "sudo -n -u postgres psql -X -qAt -F '|' -v ON_ERROR_STOP=1 -v snapshot='$snapshot' -d wd" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL application_name = 'echo_ai_eval_3108_preflight';
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SELECT worker_enabled,
       worker_ai_engine_id IS NOT NULL,
       md5(prompt),
       (
           SELECT count(*)
           FROM ai_callsign_worker_job AS job
           INNER JOIN sigint_inbox_item AS inbox
               ON inbox.id = job.sigint_inbox_item_id
           WHERE inbox.datetime < :'snapshot'::timestamptz AT TIME ZONE 'UTC'
       )
FROM ai_callsign_settings
WHERE id = 1;
COMMIT;
SQL
)"
  if [[ "$row" != "t|t|$expected_prompt_md5|0" ]]; then
    echo "$server failed preflight (enabled|engine|prompt_md5|queue): $row" >&2
    exit 1
  fi
}

extract_server() {
  local server="$1"
  local start="${activation[$server]}"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$server" \
    "sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1 -v activation='$start' -v snapshot='$snapshot' -d wd" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL application_name = 'echo_ai_eval_3108_extract';
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
COPY (
    WITH params AS (
        SELECT
            :'activation'::timestamptz AT TIME ZONE 'UTC' AS period_start,
            :'snapshot'::timestamptz AT TIME ZONE 'UTC' AS period_end
    ), selected_messages AS (
        SELECT DISTINCT
            message.id,
            coalesce(message.body, '') AS body,
            inbox.datetime
        FROM sigint_inbox_item_callsign AS callsign
        INNER JOIN sigint_inbox_item AS inbox
            ON inbox.id = callsign.sigint_inbox_item_id
        INNER JOIN signal_message AS message ON message.id = inbox.id
        CROSS JOIN params
        WHERE callsign.source = 'primary'::sigint_inbox_item_callsign_source
          AND NOT callsign.deleted
          AND NOT message.deleted
          AND inbox.datetime >= params.period_start
          AND inbox.datetime < params.period_end
    )
    SELECT
        selected.body AS "source message",
        parsed.callsigns AS "all parsed callsigns",
        parsed.callsigns AS "expected callsigns"
    FROM selected_messages AS selected
    CROSS JOIN LATERAL (
        SELECT coalesce(
            jsonb_agg(callsign.callsign ORDER BY callsign.ordering, callsign.id),
            '[]'::jsonb
        )::text AS callsigns
        FROM sigint_inbox_item_callsign AS callsign
        WHERE callsign.sigint_inbox_item_id = selected.id
          AND callsign.source = 'primary'::sigint_inbox_item_callsign_source
          AND NOT callsign.deleted
    ) AS parsed
    ORDER BY selected.datetime, selected.id
) TO STDOUT WITH (FORMAT csv, HEADER true);
COMMIT;
SQL
}

for server in "${servers[@]}"; do
  preflight_server "$server"
done

ssh -o BatchMode=yes -o ConnectTimeout=10 echo-siversk \
  "sudo -n -u postgres psql -X -qAt -v ON_ERROR_STOP=1 -d wd" <<'SQL' \
  > "$tmp_dir/prompt.b64"
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL application_name = 'echo_ai_eval_3108_prompt';
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SELECT encode(convert_to(prompt, 'UTF8'), 'base64')
FROM ai_callsign_settings
WHERE id = 1;
COMMIT;
SQL
base64 --decode "$tmp_dir/prompt.b64" > "$tmp_dir/prompt.txt"
if [[ "$(md5sum "$tmp_dir/prompt.txt" | cut -d ' ' -f 1)" != "$expected_prompt_md5" ]]; then
  echo "Extracted prompt checksum does not match production" >&2
  exit 1
fi
mv "$tmp_dir/prompt.txt" "$eval_dir/prompt.txt"

for server in "${servers[@]}"; do
  echo "Extracting $server" >&2
  extract_server "$server" > "$tmp_dir/$server.csv"
done

python3 - "$tmp_dir" "$raw_dir/callsigns.csv" "${servers[@]}" <<'PY'
import csv
import pathlib
import sys

tmp_dir = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
servers = sys.argv[3:]
header = ["source message", "all parsed callsigns", "expected callsigns"]
with output.open("w", newline="", encoding="utf-8") as output_file:
    writer = csv.writer(output_file)
    writer.writerow(header)
    for server in servers:
        with (tmp_dir / f"{server}.csv").open(newline="", encoding="utf-8") as input_file:
            reader = csv.reader(input_file)
            if next(reader) != header:
                raise SystemExit(f"unexpected CSV header for {server}")
            writer.writerows(reader)
PY

python3 "$eval_dir/validate.py" "$raw_dir/callsigns.csv"
