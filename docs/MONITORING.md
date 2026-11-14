# SigNoz monitoring

SigNoz is available only from the Eagle Atria Tailscale network.

## For humans

- [Errors dashboard](http://signoz-echo.eagle-atria.ts.net:8080/dashboard/019fcb8d-cc4f-7e13-869d-2d6029b687d2?relativeTime=1h)
- [AI providers dashboard](http://signoz-echo.eagle-atria.ts.net:8080/dashboard/01a1ab5f-22f4-7764-a7c1-5c44d57675c1?relativeTime=6h)
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
working, open **All dashboards**, find the dashboard, and update this document
with its new link.

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

`severity_text` is empty for Echo application logs, so match on `body`. The
Errors dashboard counts any line containing `error` in any case, including INFO
lines and the continuation lines of multi-line errors. A bar therefore counts
lines rather than failures. To explain one, run the panel's own filter.

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

### nginx response counts

nginx doesn't write access logs; there are too many requests to store them
on the hosts. Each Echo site sends only its response status as a UDP syslog
datagram to `echo-vector` on `127.0.0.1:5140`. Vector counts the statuses in
memory and sends one row per host per minute: `service.name=nginx`,
`source_type=nginx_status`, with the numbers `nginx_responses`, `nginx_2xx`,
`nginx_3xx`, `nginx_4xx` and `nginx_5xx`. The ERRORS dashboard's
**NGINX NON-2XX** panel plots `sum(nginx_responses) - sum(nginx_2xx)` per
5 minutes, one line per host. Paths and clients are not recorded.

While `echo-vector` is stopped, the datagrams are lost and nginx writes a
`send() failed (111: ...)` line to its `error.log` for most requests. Keep
Vector restarts short. On a new host, start Vector with this config before
enabling the nginx directive.

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

### Export settings

Admins switch metrics export on and set the OTLP gRPC endpoint, such as
`http://signoz-echo.eagle-atria.ts.net:4317`, on the **Моніторинг** tab of the
system settings. Every Echo process builds its exporter at start, so a change
applies after Echo and the report worker restart.

These settings used to be the `signoz_metrics_enabled` and
`signoz_metrics_endpoint` keys in `/etc/echo/config.toml`. When the saved
settings are still empty, `echo-web` and `echo-bgworker` copy those keys into
them at start and log that the keys can be removed. Until then, and whenever a
process cannot read the settings, the keys still apply. Once the settings are
saved, the keys are ignored. Remove them from `config.toml` and from the
server's Bitwarden config note after the import.

### Operational alert signals (#4034)

The Signoz metrics export settings control these metrics (see
[Export settings](#export-settings)). Collection starts with the messenger/background workers,
independently of requests to `/api/monitoring`. Live installations have one
collector in `echo-bgworker`; debug mode uses its combined web/background process.
No new feature flag, PostgreSQL schema, runtime package, or analytics resnapshot
is required. Existing Discord senders remain enabled.
An enabled exporter with a missing or malformed HTTP(S) endpoint logs a startup
warning and leaves collection disabled.

Resources retain `service.name=wdintel-rs`, `service.namespace=echo`,
`host.name=public_host`, and, when configured, `service.instance.id=server_id`.
Use `service.instance.id` to distinguish installations; use `host.name` when the
server ID is absent. Different installations must not share both identities.
Event counters also carry `process=echo-web|echo-bgworker|echo-report-worker|echo-oneoff`
because these processes share resource identity.

In the table, **entity** means the applicable numeric database IDs
`datasource_id`, `account_id` (Echo IM account), and `client_id`, plus
`messenger=signal|whatsapp`. Missing relationships omit their IDs. Display names,
service names, phone numbers, message/response/error text, URLs, credentials,
report IDs, and user IDs are never exported as labels.

| Instrument | Type / unit | Labels and meaning |
| --- | --- | --- |
| `echo.datasource.activity.age` | Gauge / `s` | entity, `source=datasources`; age at the observation time, clamped to zero for future timestamps |
| `echo.datasource.active` | Gauge / `1` | entity, `source=accounts`; 1 active, 0 paused |
| `echo.system.filesystem.available_bytes` | Gauge / `By` | `mountpoint=/`, `source=filesystem`; available bytes, not total or free bytes including reserved blocks |
| `echo.messenger.account.linked` | Gauge / `1` | entity, `source=accounts`; explicit 1 linked, 0 unlinked |
| `echo.messenger.account.active` | Gauge / `1` | entity, `source=accounts`; 1 has an active Echo datasource, 0 paused or unmapped |
| `echo.messenger.restapi.errors.count` | Cumulative counter / `1` | `path=echo_im`, `messenger=signal`, `operation=receive|send|request`, `error_kind=timeout|other`, `process`, known client/account/datasource IDs |
| `echo.report.timeouts.count` | Cumulative counter / `1` | `report_kind`, `process`; one winning timeout transition per generation attempt |
| `echo.operational.source.available` | Gauge / `1` | `source=accounts|datasources|filesystem|queue|nlp`; fresh successful observation=1, failure/expiry=0 |
| `echo.operational.source.updated_at` | Gauge / `s` | `source`; Unix time of the last successful observation, absent until first success |

State collection runs at startup and every **60 seconds**; the existing OTLP
reader exports every **60 seconds**. Queue collection retains its separate
60-second loop. Per-source collection and database statements have a **10-second**
budget. Sources do not overlap their own collection, and failures in one do not
stop unrelated sources. State expires after **180 seconds** even if its collector
stops progressing. Allow collection plus export delay when comparing with the UI.

Each successful collection replaces its source snapshot, including an empty
snapshot. An unavailable source emits availability=0 and omits its data instead
of reporting zeros or carrying old healthy values forward. The last-success time
is retained and does not advance on failure. A real zero-byte filesystem result
is available=1; a failed filesystem read is available=0 with no byte value.
NLP not-ready responses and transport failures are observed unhealthy readiness
(`echo.messenger.nlp.ready=0`); a collector timeout/expiry is source unavailability.

Reuse `echo.messenger.queue.items` (`state=total|due`),
`echo.messenger.queue.oldest.age`, and `echo.messenger.nlp.ready`. These gauges
now also carry their `source` and use the same availability/expiry rules.
Processing counters and latency histograms retain their existing names and labels.
An empty queue successfully publishes zero depth and zero age.

#### Freshness and lifecycle

The endpoint and collector share Echo IM's timestamp selector:
`last_inbox_at_ms.unwrap_or(last_sync_at_ms)`. Inbox time is the maximum
`echo_inbox_message.created_at` per account, unless it predates `linked_at`.
The sync fallback retains the existing 10-minute stale/unlinked adjustment and
seven-day fallback for missing sync time. Inbox time takes precedence even when
sync time is newer. The endpoint retains its response shape and five-second cache.
For an exact comparison, use the same identified account row and UTC observation
time; subtract its selected milliseconds from that time and clamp at zero.

Paused entities remain observable with active=0. Qualify inactivity/unlinked
alerts by active=1. Pausing does not manufacture a linked or fresh state.
Deleted Echo datasources disappear from the next successful inventory; a retained
Echo IM account can remain as an unmapped account with active=0. Deleted Echo IM
clients and removal-requested account locks are omitted. Inventory and freshness
use one read-only repeatable-read database snapshot, and their replacement
snapshots are published together. An inventory failure omits state and
sets availability=0; it does not imply deletion. Datasources with no corresponding
monitoring account have no activity-age point; an absent age is unknown, not zero.
The API's pre-existing population is unchanged, so API-only rows can exist.

Historical SigNoz points are not deleted when a label set disappears. For a
state query, select each installation's latest source export first, require
availability=1 and a last-success time younger than 180 seconds, then retain only
entity points belonging to that export/current snapshot. Do not use an unrestricted
long-window last-value query or replace absent values with zero. Apply current
active inventory when alerting on accounts; relinking can change identity labels.
Use a separate no-data condition when no source export has arrived for 180 seconds:
missing exports must not resolve an unhealthy alert. Availability=0 detects a
running exporter with failed/stalled collection; no-data detects loss of exporter
or ingestion. Counter alerts use increases/rates, with reset handling, rather
than raw cumulative values. Keep process identity when calculating increases,
then aggregate across processes as needed.

#### Discord condition mapping and gaps

| Condition / sender | Signal and evaluation |
| --- | --- |
| Datasource freshness from `/api/monitoring` | Activity age, qualified by active inventory and fresh available sources. External consumers' thresholds are not present in this repository; preserve their configured thresholds when creating rules. |
| Root space from `/api/monitoring` | Available bytes on `/`; convert existing API thresholds from truncated MiB (1 MiB = 1,048,576 bytes). External alert thresholds are not defined in Echo. |
| Unlinked datasource (`messenger/worker/mod.rs`) | Linked=0 and active=1. Discord retries failed deliveries and suppresses successful repeats for one hour; metric state continues every minute. |
| Batched Signal errors (`echo-im`'s `signal/restapi_error_alert.rs`) | Error-counter increases by client/account and kind. Discord batches up to three previews and has a ten-minute per-client cooldown; metrics are independent of notification delivery and database commit. |
| Signal timeout burst (`server/healthcheck.rs`) | Intended condition: more than four receive timeouts in 15 minutes, with a one-hour Discord cooldown. **Legacy gap:** that worker reads `signal_restapi_error`; current Echo IM writes `echo_restapi_error`. The legacy receive function has no callers in this repository. New `path=echo_im` counters do not claim to reproduce historical/external legacy-table inserts. |
| Report timeout (`report_history.rs`) | Timeout-counter increase by kind. Limits remain one hour, or three hours for Etalonka; both direct timeout and periodic sweep count only the winning database transition. |
| Queue/processing/NLP | Existing queue depth/age, processing outcome/latency, ingestion, and NLP readiness instruments; keep the existing recommendations below and add source availability/no-data checks. |
| Private-message Discord notification | Informational notification, deliberately outside operational metric parity; no message content or private-message receipt counter is exported. Discord delivery continues. |
| Deployment/CI Discord messages | Workflow notifications from `justfile` and `scripts/notifications`, outside application metric coverage. |
| ML training completion (`echo-ai/src/echo_ai/upload.py`) | Informational training/artifact notification, outside runtime operational metric parity. |

The structured Echo IM observer distinguishes typed transport/elapsed timeouts and
`process killed as timeout reached` from other errors. Receive errors include
partial responses containing valid messages plus a trailing error. Handled
`FileAlreadyExistsException` responses are excluded. Each receive/send attempt is counted at most once across nested error handling;
internal retries and subsequent calls are separate observations. Failed API
responses are counted even if a later retry succeeds. Other observed request transport failures have operation=request
and client-level attribution. Non-receive/send parsing failures outside these
boundaries and independent CLI/standalone Echo IM processes are not covered.
Errors lacking account identity remain client-level; they are not assigned to a
phone number or replicated into every account's series.

Known report kinds and current Signal client/account error combinations publish
zero counter series before their first error. Cumulative error series retain
their original identity labels after reassignment or removal until restart;
their presence does not establish current account membership or activity.
Use current available inventory to qualify account alerts. Counters reset on
restart; there is no historical replay. Abrupt exits can lose observations since
the last 60-second export. Report updates and metric export are not one atomic durable
transaction; a crash between them can lose an event. Ordinary report failures,
cancellations, and restart recovery do not increment the timeout counter.

#### Rollout verification

Finish local functional tests and query-cost review first. The freshness read
still aggregates inbox history for live accounts (using the existing account
index), and has a statement timeout; representative production-scale plan evidence
is required before enabling it on an installation. Do not add an unreviewed index
or run an analytics resnapshot to bypass a slow-query failure.

Read-only `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)` on `echo-cbr`
on 2026-11-05 measured the current live-account freshness aggregation at
0.287 ms (110 inbox rows, 13 shared buffers) and the inventory query at
0.334 ms (5 result rows, 19 shared-buffer hits). Both ran inside a read-only
transaction with a 10-second statement timeout and rollback. The small current
CBR population does not establish cost on larger installations; repeat plan
review there before enabling export.

After approval naming the operation and installation, deploy the application
with the pinned Echo IM commit, configure the existing exporter if necessary,
and restart only the approved services. No separate Signal/WhatsApp package
upgrade is needed. Changes to SigNoz alert definitions need their own approval.
Verify healthy state points and zero counters arrive with the expected resource
and numeric IDs, compare activity age at a shared observation time, and observe
failed/recovered/expired sources with approved fixtures. Confirm Discord remains
enabled. Fault injection on a real environment requires approval as well.

### Admin KPI snapshots

The API process collects the system-wide, unfiltered `/admin/kpi` values at
startup and hourly while `signoz_kpi_metrics_enabled = true` and metrics export
is enabled with an endpoint.
KPI collection defaults to disabled when its flag is absent. An enabled KPI flag
without a usable metrics exporter logs a startup warning. Enable it on an
approved rollout target after checking query plans/cost for that instance's
data volume ([local scale evidence](query-plans/3826-kpi.md)); healthy
7/30/90-day API-quality refreshes perform 360 six-hour reads
per hour, bounded by the source budgets below. It uses the existing OTLP exporter
and resource attributes (`service.name=wdintel-rs`, `host.name=public_host`,
`service.instance.id=server_id`). Background/report processes do not collect
these snapshots, and opening the dashboard is not required.

All `echo.kpi.*` instruments are **gauges**, including names ending in
`.count`: retained records and rolling-window populations can decrease. Query
their latest values, not their rates or sums over time. Historical sources use
`window=7d|30d|90d`; accounts use `current`, the all-time retained successful
report count uses `all`, and this API process's activity queue uses `process`.

| Metric | Dimensions and meaning |
| --- | --- |
| `echo.kpi.source.available` | `source`, `window`; 1 for a successful, fresh snapshot, otherwise 0. |
| `echo.kpi.source.updated_at` | `source`, `window`; snapshot's UTC end/as-of time in Unix seconds. |
| `echo.kpi.accounts.count` | Current accounts in the admin list scope, including technical accounts. |
| `echo.kpi.accounts.status.count` | `status=active|admin|inactive|organism|unknown`, matching dashboard precedence. |
| `echo.kpi.accounts.recency.count` | `scope=active|blocked`, `recency=recent|aging|stale|missing|invalid`; UTC age uses the dashboard's millisecond precision. Both scopes partition all accounts. |
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
so removed groups and percentiles stop being exported. Snapshots expire two
hours after their UTC as-of time, including time spent collecting them.

Omission does not delete historical SigNoz points. Reconcile each resource,
source, and window against its latest successful snapshot: require availability
1, an as-of time less than two hours old, and points observed in the current
export. A latest-value query over a longer interval can otherwise retain an old
role, percentile, or failed source. Do not carry missing percentiles forward or
replace them with zero. Absent count groups represent zero only in a confirmed
available current snapshot.

Collection is sequential, cancellable, and never overlaps itself. It reuses
the dashboard's read-only transactions and query limits; each source/window
has a five-minute total budget. API-quality reads use adjacent six-hour slices,
as the dashboard does, and publish only after every slice succeeds. Successful
and empty request slices are reused across windows within one refresh, keeping
overlapping window counts consistent; failures are retried in later windows.
Report metrics skip the dashboard's unused author/day breakdowns, so author
cardinality does not invalidate exported totals. Greptime
retention/loss still limits coverage; availability does not establish complete
history. No user IDs, account names, per-author/per-page breakdowns, or dates
are metric labels. A source exceeding 500 points for one instrument/window is
unavailable rather than silently truncated. Production query cost and fresh
ingestion should be checked on the approved rollout target.

For rollout verification, compare snapshots with unfiltered dashboard values
using the same UTC half-open period `[since, until)` and account as-of time:

- Account statuses and recency categories must each partition the account total;
  role totals may exceed it because accounts can have multiple distinct roles.
- Report `done + failed + other` equals retained requests in the creation window;
  kinds and included/excluded generation samples each sum to `done`. `all/done`
  includes all retained successful reports, regardless of creation date.
- Notification status counts sum to retained jobs; included/excluded transport
  samples sum to `sent`. These are transport jobs rather than recipient receipts.
- API status counts and error ratios use only recorded observations, including
  empty six-hour slices around nonempty slices. Request IDs are deduplicated
  within each status and slice. Activity counts are distinct stable UUIDs across
  all pages/days; unmapped groups remain separate. Neither source proves complete
  retained history.

Repeat after removing a role, after a source fails, and after the two-hour
freshness limit to check downstream queries do not display previous values.
This feature changes no replicated schema, exclusions, or migration-impact
declarations and requires no analytics resnapshot or mirror reconciliation.
Configuration changes and service restarts still require approval naming the
rollout operation and server.

### AI provider metrics

`wdintel-rs` records model calls made through the application's shared
`AiEngineClient`. Read these on the **AI providers** dashboard, which is defined
in `deploy/signoz/dashboards/ai-providers.json`.

| Metric | Attributes | Meaning |
|---|---|---|
| `echo.ai_provider.requests.count` | `provider`, `model_name`, `process`, `streaming`, `outcome` | One per call, including calls that never reached the provider. |
| `echo.ai_provider.response_start.duration` | same | Seconds from sending the call until response headers. |
| `echo.ai_provider.stream.duration` | `provider`, `model_name`, `process`, `outcome` | Seconds from response headers until the stream ended, for AI agent gateway streams. |

Attribute values:

- `provider`: `gov_ua`, `openai`, `internal` (plain `http` engine URLs) or
  `other`. `gov_ua` is one gateway hosting several vendors, so compare models
  by `model_name`.
- `process`: `echo-web`, `echo-bgworker`, `echo-report-worker` or `echo-oneoff`.
  All processes share one metric identity, so always keep this attribute: their
  cumulative counters would otherwise collide. AI chat calls go through the
  agent gateway in `echo-web`; `echo-bgworker` makes background calls such as
  OCR and callsign parsing. The dashboard's `process` filter separates them.
- `streaming`: for a non-streamed call, headers usually arrive when generation
  finishes, so `response_start` is close to the full response time. For a
  streamed call it is only the wait before output begins.
- `outcome`: `ok`, `rate_limited`, `client_error`, `server_error`, `timeout`,
  `connect_error`, `transport_error`, `cancelled`, `cooldown_expired` or
  `local_error`. The last two never reached the provider, so they are counted
  but add no duration sample.
- Stream `outcome`: `completed`, `failed` or `cancelled`. `failed` includes a
  stream that carried a provider error event, or closed without finishing.

When reading the numbers:

- `ok` means headers arrived. A stream can still fail afterwards, so check the
  stream outcomes too.
- A hung provider mostly appears as `cancelled`, not `timeout`, because the
  outer timeout fires first. `cancelled` also covers runner aborts and the
  worker time limit, so it is not always the provider's fault.
- To see which model is failing, read **Failed calls per interval by model**
  (counts by model and outcome) and **Failed share by model, %**. An outage of
  one model shows there as that model's bars and a share near 100%, for example
  `glm-5.3-flash-uncensored` on 2026-11-13 from 04:06 UTC. **Failed calls per
  minute by outcome** sums every selected model into one line per outcome.
- `response_start` excludes Echo's local 429 cooldown wait, but includes the
  settings load, the Azure token fetch and any 401 retry. Caller latency can
  therefore be much longer than the provider time shown.
- Stream duration includes backpressure from the reader.
- Bgworker and report-worker can lose up to the last 60 seconds of data on
  restart, because only the web process shuts metrics down explicitly.

Not covered: agent `DirectHttp` engines, the document extractor's direct vLLM
calls, Echo GPU transcription, and command-line tools that build their own
client, such as callsign reprocessing and `ai-position-eval`. vLLM has its own
metrics. Only hosts with metrics export enabled send any of these metrics.

Change the dashboard by editing the JSON, then run
`just signoz-install-dashboard --verify` to run every panel's queries without
saving, and `just signoz-install-dashboard` to save it.

Percentile panels must use ClickHouse SQL. The ClickHouse on `signoz-echo` has
no `histogramQuantile` function, so a percentile on a histogram in the SigNoz
query builder fails with an HTTP 500. The dashboard uses ClickHouse's built-in
`quantilePrometheusHistogram` instead.

### Automatic engine health

The same call outcomes drive the engine health flag that the AI chat uses to
steer users to a working model (`wdintel-rs/src/ai_engine/health.rs`, #4157).
Every call through `AiEngineClient`, from every process, is counted in
per-minute Redis counters under `ai-engine:health:<engine id>:<minute>` when it
starts, and its outcome when it ends. A stream counts by how it ended, not by
its headers. The gateway reads its SSE events. A stream fails if an event
carries `error`, has a `network_error` finish reason, or is
`response.failed`/`error`, and that counts at once, even if the client then
leaves. It also fails if it closes without finishing: a chat choice with
another `finish_reason` (`[DONE]` alone is not enough), or
`response.completed`/`incomplete`. A non-streamed call counts when its headers
arrive, because the provider sends them only once the answer is ready. Calls and
streams still running are listed in `ai-engine:health:<engine id>:in-flight`;
entries older than 2 hours were left by a dead process and are ignored. Once a
minute one instance, whichever claims
`ai-engine:health:round`, checks every enabled engine:

- A healthy engine is marked unhealthy when more than 90% of at least 5 calls
  in the last 30 minutes failed at the provider (`rate_limited`,
  `server_error`, `timeout`, `connect_error`, `transport_error`, or a stream
  that broke off). Other outcomes show traffic but say nothing about the
  provider.
- An engine the worker marked recovers when at most half of at least 2 calls
  in the last 10 minutes failed.
- If nobody called it for 10 minutes, it is probed at most once every 5
  minutes with a one-word chat completion, and any 2xx answer clears the mark.
  Probes are not counted as calls, and an engine someone still calls, or has a
  call running on however long, is never probed. This is checked again just
  before the probe is sent; users take no lock, so a call can still start in
  the milliseconds between that check and the probe.

Only outcomes after the latest health change count; every writer stamps
`health_updated_at`. The worker's unhealthy marks have no
`health_updated_by_login_id` and a message starting with «Автоматично:». A mark
set by an administrator (with a login) or by a profile import with its own
message is never changed back automatically. A profile import that copies the
worker's «Автоматично:» mark from another host stays automatic, and recovers on
this host's own evidence. The flag does not block calls:
background jobs keep using the engine, and their outcomes count too. Look for
`ai_engine_health` lines in the bgworker journal to see each decision.

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
