# SigNoz monitoring

SigNoz is available only from the Eagle Atria Tailscale network.

## For humans

- [Errors dashboard](http://signoz-echo.eagle-atria.ts.net:8080/dashboard/019fcb8d-cc4f-7e13-869d-2d6029b687d2?relativeTime=1h)
- [All dashboards](http://signoz-echo.eagle-atria.ts.net:8080/dashboard)
- [Logs Explorer](http://signoz-echo.eagle-atria.ts.net:8080/logs/logs-explorer?relativeTime=1h)

In Logs Explorer, load the saved `ERROR`, `WARN`, or `OPS` view. To inspect one
installation, add the resource filter `host.name IN <host-name>`. For example,
the SSH host `echo-skhid` sends application logs as `ct-echo-skhid`. Its paired
analytics container uses `ct-echo-skhid-clickhouse`.

Use a personal SigNoz account. SSH access does not reveal the browser password:
SigNoz stores password factors, not recoverable plaintext passwords, in
`/var/lib/signoz/signoz.db`. Ask a SigNoz administrator to invite the user or
reset access when necessary.

Dashboard IDs change when a dashboard is recreated. If a direct link stops
working, open **All dashboards**, find the errors dashboard, and update this
document with its new link.

## For agents over SSH

Use `ssh signoz-echo`; `ssh signoz-echo hostname` returns
`ct-signoz-echo`.

The central logs are in the `signoz_logs.logs_v2` ClickHouse table on
`signoz-echo`. Useful fields are:

- `timestamp` and `severity_text` for event time and severity;
- `body` for the log message;
- `resources_string['host.name']` for the machine;
- `resources_string['service.name']` for the systemd service.

The ClickHouse password is the `password` query parameter of
`SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_DSN` in
`/opt/signoz/conf/systemd.env`. Do not print or copy it. The commands below
parse it directly into the temporary remote process environment and remove it
when the process exits.

The credential is not a read-only account. Agent inspection must use only
`SELECT`, `SHOW`, and `DESCRIBE`; never run DDL or data-changing queries.

### Discover host names

Host resource names are usually `ct-echo-<site>`, but some older and special
hosts use different names. Discover the exact value before querying:

```bash
ssh signoz-echo 'sudo bash -s' <<'SIGNOZ_QUERY'
set -euo pipefail

hours=24

set -a
. /opt/signoz/conf/systemd.env
set +a
CLICKHOUSE_PASSWORD="$(
    python3 - <<'PY'
import os
import urllib.parse

dsn = urllib.parse.urlparse(os.environ["SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_DSN"])
print(urllib.parse.parse_qs(dsn.query)["password"][0])
PY
)"
export CLICKHOUSE_PASSWORD
trap 'unset CLICKHOUSE_PASSWORD SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_DSN' EXIT

clickhouse-client \
    --param_hours="$hours" \
    --query "
SELECT
    resources_string['host.name'] AS host_name,
    count() AS log_rows,
    fromUnixTimestamp64Nano(toInt64(max(timestamp))) AS latest
FROM signoz_logs.logs_v2
WHERE timestamp >=
    (toUInt64(toUnixTimestamp(now())) - {hours:UInt32} * 3600) * 1000000000
GROUP BY host_name
HAVING host_name != ''
ORDER BY host_name
FORMAT PrettyCompactMonoBlock"
SIGNOZ_QUERY
```

### Read recent errors for one host

Change `host_name`, `hours`, or `row_limit` at the top. The timestamp predicate
and row limit are mandatory because the table receives a high volume of logs.

```bash
ssh signoz-echo 'sudo bash -s' <<'SIGNOZ_QUERY'
set -euo pipefail

host_name=ct-echo-skhid
hours=1
row_limit=100

set -a
. /opt/signoz/conf/systemd.env
set +a
CLICKHOUSE_PASSWORD="$(
    python3 - <<'PY'
import os
import urllib.parse

dsn = urllib.parse.urlparse(os.environ["SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_DSN"])
print(urllib.parse.parse_qs(dsn.query)["password"][0])
PY
)"
export CLICKHOUSE_PASSWORD
trap 'unset CLICKHOUSE_PASSWORD SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_DSN' EXIT

clickhouse-client \
    --param_host_name="$host_name" \
    --param_hours="$hours" \
    --param_row_limit="$row_limit" \
    --query "
SELECT
    fromUnixTimestamp64Nano(toInt64(timestamp)) AS event_time,
    resources_string['host.name'] AS host_name,
    resources_string['service.name'] AS service_name,
    severity_text,
    body
FROM signoz_logs.logs_v2
WHERE timestamp >=
    (toUInt64(toUnixTimestamp(now())) - {hours:UInt32} * 3600) * 1000000000
  AND resources_string['host.name'] = {host_name:String}
  AND (severity_text ILIKE '%error%' OR body ILIKE '%error%')
ORDER BY timestamp DESC
LIMIT {row_limit:UInt32}
FORMAT Vertical"
SIGNOZ_QUERY
```

This SSH query deliberately returns a broad set of error-like messages. The UI
saved `ERROR` view owns the current noise exclusions and may show fewer rows.

To restrict the SSH query to one service, add a parameter to
`clickhouse-client`:

```bash
--param_service_name=wdintel-rs
```

and add this predicate before `ORDER BY`:

```sql
AND resources_string['service.name'] = {service_name:String}
```

Common Echo services include `wdintel-rs`, `wdintel-rs-bgworker`,
`wdintel-rs-report-worker`, `postgresql`, `echo-signal-bot`, and
`echo-whatsapp-bot`.

### Alert API credentials

Alert management needs an authenticated SigNoz API key with alert-write
permission. The existing active `claude` service account has an `api` key and
the `signoz-editor` role; that role can create and update alerts. An Admin
credential is also sufficient. SSH and ClickHouse credentials are separate
from API authentication.

The existing service-account key is stored in `factor_api_key` in
`/var/lib/signoz/signoz.db`, linked to `service_account` and
`service_account_role`. Read it only on `signoz-echo` with a SQLite
`mode=ro` connection and put it in `SIGNOZ_API_KEY` for the temporary remote
process. Use `SIGNOZ_URL=http://127.0.0.1:8080` there. Never print the key,
copy it into this repository, change authentication tables, or use
`SIGNOZ_JWT_SECRET` as an API credential. Check account status, expiry and
permissions again when using the key.

The [OCR storage runbook](../echo-document-extractor/STORAGE_RECOVERY.md#monitoring-and-rollback)
owns its alert installer and thresholds. It targets
`ct-echo-document-extractor/worker` and sends to `mattermost monitoring`:
spool warnings/critical above 160/180 GiB, and free-space warnings/critical
below 40/25 GiB, sustained for five minutes. Verify saved rules through the
authenticated API after applying them. An enabled rule in `inactive` state
is healthy when its threshold is not currently met.

### Audit messenger media storage

Audit media created since the new storage path was introduced in bounded
pages. The command only reads PostgreSQL and object storage unless `--apply`
is supplied:

```bash
sudo /usr/bin/wdintel-rs --mode=live oneoff-audit-media-storage \
  --since-ts 2026-07-20T00:00:00Z \
  --limit 10000 \
  --concurrency 8 \
  --output /var/tmp/media-storage-audit-1.jsonl
```

Use the printed UUID as `--after-media-id` for the next page and choose a new
output path. Records are classified as `available`, `missing`, `unreadable`,
or `stat_mismatch`. To repair audited rows, create a JSONL manifest with one
object per line:

```json
{"media_id":"01a02a3f-e1e0-7c00-961d-b57bd98be83c","source_path":"/path/to/original"}
```

First run with `--repair-manifest` but without `--apply` to validate source
sizes. Add `--apply` to upload a fully verified replacement and update the
media row. The corrupt object is retained for provider investigation and
manual cleanup.

Terminal object-read failures remain `ERROR`: they represent a failed user
request after transport retries. Count one `Internal server error` row per
failure; do not downgrade these rows to warnings or count nested error text as
another failure.

### Troubleshooting

- No expected host: increase the discovery window, then check
  `sudo systemctl status echo-vector` on the source Echo host.
- No recent logs from any host: run
  `ssh signoz-echo 'systemctl is-active signoz signoz-otel-collector clickhouse-server'`.
- UI and SSH results differ: confirm the same time range and `host.name`; the
  saved UI views also contain noise exclusions.
- Too much output: shorten `hours`, lower `row_limit`, or filter by
  `service.name`. Do not remove the timestamp predicate or limit.

## Metrics

### Admin KPI snapshots

The API process collects the system-wide, unfiltered `/admin/kpi` values at
startup and hourly while `signoz_kpi_metrics_enabled = true`,
`signoz_metrics_enabled = true`, and `signoz_metrics_endpoint` is configured.
KPI collection defaults to disabled when its flag is absent. Enable it on an
approved rollout target after checking query plans/cost for that instance's
data volume; 7/30/90-day API-quality refreshes can perform 508 six-hour reads
per hour, bounded by the source budgets below. It uses the existing OTLP exporter
and resource attributes (`service.name=wdintel-rs`, `host.name=public_host`,
`service.instance.id=server_id`). Background/report processes do not collect
these snapshots, and opening the dashboard is not required.

All `echo.kpi.*` instruments are **gauges**, including names ending in
`.count`: retained records and rolling-window populations can decrease. Query
their latest values, not their rates or sums over time. Historical sources use
`window=7d|30d|90d`; accounts use `current`, retained successful reports use
`all`, and this API process's activity queue uses `process`.

| Metric | Dimensions and meaning |
| --- | --- |
| `echo.kpi.source.available` | `source`, `window`; 1 for a successful, fresh snapshot, otherwise 0. |
| `echo.kpi.source.updated_at` | `source`, `window`; snapshot's UTC end/as-of time in Unix seconds. |
| `echo.kpi.accounts.count` | Current accounts in the admin list scope, including technical accounts. |
| `echo.kpi.accounts.status.count` | `status=active|admin|inactive|organism|unknown`, matching dashboard precedence. |
| `echo.kpi.accounts.recency.count` | `scope=active|blocked`, `recency=recent|aging|stale|missing|invalid`; sum both scopes to include active accounts. |
| `echo.kpi.accounts.role.count` | `role`; each distinct role counts once per account. |
| `echo.kpi.accounts.organism.count` | `organism_id`; missing associations use `missing`. |
| `echo.kpi.accounts.direction.count` | `direction_id`; missing associations use `missing`. |
| `echo.kpi.reports.count` | `status=done|failed|other`; sums to requests in the creation window. `window=all` exports only `done`. |
| `echo.kpi.reports.kind.count` | `kind`; retained successful reports in the window. |
| `echo.kpi.reports.generation.duration` | `statistic=median|p90`, seconds; same valid worker samples as the dashboard. |
| `echo.kpi.reports.generation.samples` | `outcome=included|excluded`; successful reports included/excluded from duration sampling. |
| `echo.kpi.notifications.count` | `status=queued|sending|sent|failed|skipped`; retained transport jobs, not device receipts. |
| `echo.kpi.notifications.transport.duration` | `statistic=median|p90`, seconds from creation to sent time. |
| `echo.kpi.notifications.transport.samples` | `outcome=included|excluded`; sent jobs with/without valid duration. |
| `echo.kpi.activity.accounts.count` | Distinct observed account UUIDs; includes keep-alives and technical accounts, not human DAU/WAU/MAU. |
| `echo.kpi.activity.unmapped_groups.count` | Observation groups without stable account UUIDs. |
| `echo.kpi.activity.queue.count` | `outcome=enqueued|dropped`; events in this API process since startup. |
| `echo.kpi.api.responses.count` | `status`; recorded `/api/` responses and middleware errors, deduplicated by request ID within status. |
| `echo.kpi.api.errors.ratio` | `(4xx + 5xx) / recorded responses`, a fraction from 0 to 1. |

Each value also has `source` and `window`. Missing Greptime configuration,
empty observations, errors, and timeouts produce availability 0 and omit the
affected values. Valid empty PostgreSQL history produces zero counts; absent
duration samples omit percentiles. Each refresh replaces its source snapshot,
so removed groups and percentiles disappear. Snapshots expire after two hours.

Collection is sequential, cancellable, and never overlaps itself. It reuses
the dashboard's read-only transactions and query limits; each source/window
has a five-minute total budget. API-quality reads use adjacent six-hour slices,
as the dashboard does, and publish only after every slice succeeds. Greptime
retention/loss still limits coverage; availability does not establish complete
history. No user IDs, account names, per-author/per-page breakdowns, or dates
are metric labels. A source exceeding 500 points for one instrument/window is
unavailable rather than silently truncated. Production query cost and fresh
ingestion should be checked on the approved rollout target.

### Other application metrics

- `echo.device_files.synchronized.count`: кількість файлів, які API синхронізації пристроїв успішно створило або оновило, з атрибутом `operation`.
- `echo.device_files.sync_batches.count`: кількість оброблених пакетів синхронізації файлів.
- `echo.device_files.sync.duration`: гістограма тривалості обробки пакетів у секундах.
- `echo.messenger.ingested.count`: кількість нових або оновлених знімків, доданих до черги, з атрибутом `messenger`.
- `echo.messenger.processing.count`: результати обробки з атрибутами `messenger` і `outcome` (`success` або `retry`).
- `echo.messenger.processing.latency`: час від додавання до черги до результату обробки.
- `echo.messenger.queue.items`: розмір черги з атрибутом `state` (`total` або `due`).
- `echo.messenger.queue.oldest.age`: вік найстарішого елемента черги в секундах.
- `echo.messenger.nlp.ready`: готовність локального NLP (`1` або `0`).

Рекомендовані сповіщення: NLP дорівнює `0` протягом 60 секунд; вік
найстарішого елемента перевищує 120 секунд у двох послідовних хвилинних
перевірках; вік понад 300 секунд має критичний рівень. Для відокремлення
зменшення вхідного трафіку від внутрішнього відставання порівнюйте
`ingested.count` з попередніми сімома днями разом із `queue.items` і
`processing.count`.

## ClickHouse diagnostic retention

SigNoz storage maintenance uses the [bounded diagnostic-log policy](../deploy/clickhouse/README.md#signoz-clickhouse-maintenance):
1 day for trace/profiling logs, 3 days for text/asynchronous-insert logs, and
7 days for other managed diagnostics, including numeric archive tables.
Application logs remain at 15 days and metrics at 30 days. Use the SigNoz
profile's `--check` after upgrades and `--apply --expire --yes` for cleanup that
preserves recent history. ZooKeeper filesystem cleanup is separate.
