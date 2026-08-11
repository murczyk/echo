#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
eval_dir="$repo_root/ai-eval/2026-08-10-callsign-prompt"
batch="${1:-batch-01}"
server="echo-skhid"
period_start="2026-08-08T17:54:24.574648Z"
snapshot="2026-08-10T08:27:08Z"
expected_prompt_md5="e28582ad0a1e6e07be76c95dd2f33cbf"

if [[ ! "$batch" =~ ^batch-[0-9][0-9]$ ]]; then
  echo "Batch must match batch-NN" >&2
  exit 1
fi

raw_dir="$eval_dir/raw/$batch"
requested_path="$raw_dir/callsigns.txt"
if [[ ! -s "$requested_path" ]]; then
  echo "Missing callsign list: $requested_path" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

preflight="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$server" \
  "sudo -n -u postgres psql -X -qAt -F '|' -v ON_ERROR_STOP=1 -v snapshot='$snapshot' -d wd" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL application_name = 'echo_ai_eval_3108_batch_preflight';
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
if [[ "$preflight" != "t|t|$expected_prompt_md5|0" ]]; then
  echo "$server failed preflight (enabled|engine|prompt_md5|pre-snapshot queue): $preflight" >&2
  exit 1
fi

python3 - "$requested_path" "$period_start" "$snapshot" <<'PY' > "$tmp_dir/query.sql"
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
period_start = sys.argv[2]
snapshot = sys.argv[3]
callsigns = path.read_text(encoding="utf-8").splitlines()
if not callsigns or any(not callsign for callsign in callsigns):
    raise SystemExit("callsign list must contain non-empty lines")
if len(callsigns) != len(set(callsigns)):
    raise SystemExit("callsign list contains duplicates")

values = ",\n".join(
    f"        ('{callsign.replace(chr(39), chr(39) * 2)}', {index})"
    for index, callsign in enumerate(callsigns)
)
print(f"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL application_name = 'echo_ai_eval_3108_batch_extract';
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
COPY (
    WITH requested(callsign, request_order) AS (
        VALUES
{values}
    ), ranked_matches AS (
        SELECT
            requested.callsign AS requested_callsign,
            requested.request_order,
            message.id AS message_id,
            coalesce(message.body, '') AS body,
            inbox.datetime,
            row_number() OVER (
                PARTITION BY requested.request_order
                ORDER BY inbox.datetime, message.id
            ) AS match_order
        FROM requested
        INNER JOIN sigint_inbox_item_callsign AS matched
            ON matched.callsign = requested.callsign
        INNER JOIN sigint_inbox_item AS inbox
            ON inbox.id = matched.sigint_inbox_item_id
        INNER JOIN signal_message AS message ON message.id = inbox.id
        WHERE matched.source = 'primary'::sigint_inbox_item_callsign_source
          AND NOT matched.deleted
          AND NOT message.deleted
          AND inbox.datetime >= '{period_start}'::timestamptz AT TIME ZONE 'UTC'
          AND inbox.datetime < '{snapshot}'::timestamptz AT TIME ZONE 'UTC'
    ), selected_messages AS (
        SELECT
            ranked_matches.message_id,
            ranked_matches.body,
            ranked_matches.datetime,
            min(ranked_matches.request_order) AS first_request_order,
            jsonb_agg(
                ranked_matches.requested_callsign
                ORDER BY ranked_matches.request_order
            ) AS requested_callsigns
        FROM ranked_matches
        WHERE ranked_matches.match_order = 1
        GROUP BY
            ranked_matches.message_id,
            ranked_matches.body,
            ranked_matches.datetime
    )
    SELECT
        selected.requested_callsigns::text AS \"requested callsigns\",
        selected.message_id::text AS \"message id\",
        selected.body AS \"source message\",
        parsed.callsigns AS \"all parsed callsigns\",
        parsed.callsigns AS \"expected callsigns\"
    FROM selected_messages AS selected
    CROSS JOIN LATERAL (
        SELECT coalesce(
            jsonb_agg(callsign.callsign ORDER BY callsign.ordering, callsign.id),
            '[]'::jsonb
        )::text AS callsigns
        FROM sigint_inbox_item_callsign AS callsign
        WHERE callsign.sigint_inbox_item_id = selected.message_id
          AND callsign.source = 'primary'::sigint_inbox_item_callsign_source
          AND NOT callsign.deleted
    ) AS parsed
    ORDER BY selected.first_request_order, selected.datetime, selected.message_id
) TO STDOUT WITH (FORMAT csv, HEADER true);
COMMIT;""")
PY

ssh -o BatchMode=yes -o ConnectTimeout=10 "$server" \
  "sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1 -d wd" \
  < "$tmp_dir/query.sql" > "$tmp_dir/selected.csv"

python3 - "$requested_path" "$tmp_dir/selected.csv" "$raw_dir" <<'PY'
import csv
import json
import pathlib
import sys

requested_path = pathlib.Path(sys.argv[1])
selected_path = pathlib.Path(sys.argv[2])
raw_dir = pathlib.Path(sys.argv[3])
requested = requested_path.read_text(encoding="utf-8").splitlines()
selected_callsigns = set()

with selected_path.open(newline="", encoding="utf-8") as input_file:
    reader = csv.DictReader(input_file)
    expected = [
        "requested callsigns",
        "message id",
        "source message",
        "all parsed callsigns",
        "expected callsigns",
    ]
    if reader.fieldnames != expected:
        raise SystemExit(f"unexpected extraction header: {reader.fieldnames}")
    rows = list(reader)

with (raw_dir / "callsigns.csv").open("w", newline="", encoding="utf-8") as output_file:
    writer = csv.writer(output_file)
    writer.writerow(["source message", "all parsed callsigns", "expected callsigns"])
    for row in rows:
        writer.writerow(
            [
                row["source message"],
                row["all parsed callsigns"],
                row["expected callsigns"],
            ]
        )

with (raw_dir / "matches.csv").open("w", newline="", encoding="utf-8") as output_file:
    writer = csv.writer(output_file)
    writer.writerow(["requested callsigns", "message id"])
    for row in rows:
        callsigns = json.loads(row["requested callsigns"])
        selected_callsigns.update(callsigns)
        writer.writerow([row["requested callsigns"], row["message id"]])

unmatched = [callsign for callsign in requested if callsign not in selected_callsigns]
(raw_dir / "unmatched.txt").write_text(
    "".join(f"{callsign}\n" for callsign in unmatched), encoding="utf-8"
)
PY

python3 "$eval_dir/validate-batch.py" "$raw_dir"
