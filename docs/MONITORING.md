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

- `echo.device_files.synchronized.count`: кількість файлів, які API синхронізації пристроїв успішно створило або оновило, з атрибутом `operation`.
- `echo.device_files.sync_batches.count`: кількість оброблених пакетів синхронізації файлів.
- `echo.device_files.sync.duration`: гістограма тривалості обробки пакетів у секундах.
