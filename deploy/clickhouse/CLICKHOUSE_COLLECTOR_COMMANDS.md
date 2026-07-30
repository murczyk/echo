# ClickHouse Slow-Query Collector — Commands

Command reference for **`CLICKHOUSE_COLLECTOR_CHECKLIST.md`**. Section numbers
match the checklist's *Commands* column.

Substitute throughout:

```text
HOST_ALIAS   SSH alias        e.g. echo-kharkiv2-clickhouse
HOST_NAME    resource label   e.g. ct-echo-kharkiv2-clickhouse
MARKER       unique tag       e.g. verify_kharkiv2_20260730
```

Run everything from your workstation unless noted.

---

## 0. What you are building

```text
ClickHouse system.query_log
  → signoz-otel-collector          (on the ClickHouse host)
  → filter: QueryFinish AND duration >= 1000 ms
  → OTLP gRPC → signoz-echo.eagle-atria.ts.net:4317
  → SigNoz Logs → dashboard panel
```

Three artifacts: a **binary** in `/opt/signoz-clickhouse-collector/bin/`, two
**config files** in `/etc/signoz-clickhouse-collector/`, one **systemd unit**.
Two identities: OS user `signoz-clickhouse` (runs the service) and ClickHouse
user `monitoring` (reads `system.query_log`).

---

## 1. Pre-flight check

```bash
ssh HOST_ALIAS '
    hostname
    . /etc/os-release && echo "$PRETTY_NAME $(uname -m)"
    systemctl is-active clickhouse-server.service
    clickhouse-client --query "SELECT version()" 2>/dev/null || echo "auth needed"
    df -h / | tail -1
    free -g | head -2
    test -e /etc/signoz-clickhouse-collector && echo "collector PRESENT" || echo "collector absent"
'
```

Check reachability of the collector endpoint:

```bash
ssh HOST_ALIAS 'timeout 5 bash -c "</dev/tcp/signoz-echo.eagle-atria.ts.net/4317" \
    && echo "4317 reachable" || echo "4317 UNREACHABLE"'
```

Confirm query logging and the flush interval:

```bash
ssh HOST_ALIAS 'sudo bash -s' <<'EOF'
set -eu
set -a; . /etc/echo-analytics/clickhouse.env; set +a
export CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD="$CLICKHOUSE_ADMIN_PASSWORD"
clickhouse-client --query "SELECT name, value FROM system.settings WHERE name IN ('log_queries','log_queries_min_query_duration_ms') FORMAT TSV"
grep -r flush_interval_milliseconds /etc/clickhouse-server/ 2>/dev/null | head -3
EOF
```

`min_scrape_delay_seconds` (§5) must exceed the flush interval — default
7500 ms, hence 8 s.

---

## 2. Baseline query volume

```bash
ssh HOST_ALIAS 'sudo bash -s' <<'EOF'
set -eu
set -a; . /etc/echo-analytics/clickhouse.env; set +a
export CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD="$CLICKHOUSE_ADMIN_PASSWORD"
clickhouse-client --query "
SELECT count() AS completed,
       countIf(query_duration_ms >= 1000) AS slow,
       max(query_duration_ms) AS max_ms
FROM system.query_log
WHERE event_time >= now() - INTERVAL 24 HOUR AND type = 'QueryFinish'
FORMAT Vertical"
EOF
```

The `slow` count is your expectation for the dashboard. A single-digit result
means the panel will look empty — correct, not broken.

---

## 3. Transfer the binary

The binary is host-agnostic; all per-host difference lives in `config.yaml`.

### 3.1 Get a local copy

```bash
scp SOURCE_HOST:/opt/signoz-clickhouse-collector/bin/signoz-otel-collector \
    /tmp/signoz-otel-collector

ls -l  /tmp/signoz-otel-collector
shasum -a 256 /tmp/signoz-otel-collector
```

Reference build:

```text
Size:   323448560
SHA256: 633c07186c76d29ae8470e37a39084ad4cabc7b0ef79be0049797727ab1ed836
```

### 3.2 Compress and send

323 MB over Tailscale is slow, and a dropped transfer leaves a truncated
binary — this happened during the ZP2 rollout. Gzip cuts it to ~91 MB; the
checksum in 3.3 catches corruption.

```bash
gzip -1 -c /tmp/signoz-otel-collector > /tmp/signoz-otel-collector.gz
scp /tmp/signoz-otel-collector.gz HOST_ALIAS:/tmp/
```

### 3.3 Install and verify

```bash
ssh HOST_ALIAS '
    set -eu
    sudo install -d -m 0755 /opt/signoz-clickhouse-collector/bin
    gzip -dc /tmp/signoz-otel-collector.gz |
      sudo tee /opt/signoz-clickhouse-collector/bin/signoz-otel-collector >/dev/null
    sudo chmod 0755 /opt/signoz-clickhouse-collector/bin/signoz-otel-collector
    sha256sum /opt/signoz-clickhouse-collector/bin/signoz-otel-collector
    rm -f /tmp/signoz-otel-collector.gz
'
```

**Stop unless the checksum matches exactly.**

```bash
ssh HOST_ALIAS \
  '/opt/signoz-clickhouse-collector/bin/signoz-otel-collector --help' | head -5
```

This build has **no `--version` flag**. `Error: unknown flag: --version`
proves the binary runs. Only "no such file" or "cannot execute binary file"
are real failures. The version appears at runtime in the journal as
`"service.version": "dev"`.

---

## 4. Create the OS user

Unprivileged, no home directory, no login shell — only systemd starts it.

```bash
ssh HOST_ALIAS '
    sudo useradd --system --no-create-home --shell /usr/sbin/nologin signoz-clickhouse
    id signoz-clickhouse
'
```

Already logged into the host? Run the two lines separately.

> **Copy-paste warning.** Pasting a multi-line `ssh host '...'` block into an
> open remote session collapses the newlines, producing
> `useradd ... signoz-clickhouse id signoz-clickhouse` — two LOGIN arguments,
> so `useradd` prints usage and does nothing. Harmless; it fails before
> changing anything. Re-run the lines individually.

---

## 5. Create the ClickHouse user and env file

### 5.1 Why a hash

`IDENTIFIED BY 'plaintext'` writes that `CREATE USER` statement into
`system.query_log` — the table you are about to export. The password would
ship off-box in cleartext. So: generate, hash, and put only the **hash** into
SQL. Plaintext goes solely into a root-owned `0640` env file.

The `default` password lives in `/etc/echo-analytics/clickhouse.env`. Never
pass it on a command line — source it inside the heredoc so it stays out of
shell history and the process table.

### 5.2 Both in one step

The user and the env file need the same generated password, so they must be
created together.

```bash
ssh HOST_ALIAS 'sudo bash -s' <<'EOF'
set -eu

# Refuse to clobber anything pre-existing
for p in /etc/signoz-clickhouse-collector/collector.env \
         /etc/signoz-clickhouse-collector/config.yaml \
         /etc/systemd/system/signoz-clickhouse-collector.service; do
    if test -e "$p"; then echo "ABORT: $p already exists"; exit 1; fi
done

PW="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 28)"
HASH="$(printf '%s' "$PW" | sha256sum | cut -d' ' -f1)"

set -a; . /etc/echo-analytics/clickhouse.env; set +a
export CLICKHOUSE_USER=default
export CLICKHOUSE_PASSWORD="$CLICKHOUSE_ADMIN_PASSWORD"

# Least privilege: loopback only, one table, SELECT only
clickhouse-client --query \
  "CREATE USER IF NOT EXISTS monitoring IDENTIFIED WITH sha256_hash BY '$HASH' HOST IP '127.0.0.1'"
clickhouse-client --query \
  "GRANT SELECT ON system.query_log TO monitoring"

install -d -m 0750 -o root -g signoz-clickhouse /etc/signoz-clickhouse-collector

umask 027
cat > /etc/signoz-clickhouse-collector/collector.env <<ENVEOF
CLICKHOUSE_MONITORING_DSN=tcp://monitoring:${PW}@127.0.0.1:9000/
CLICKHOUSE_CLUSTER_NAME=
QUERY_LOG_SCRAPE_INTERVAL_SECONDS=20
QUERY_LOG_SCRAPE_DELAY_SECONDS=8
OTLP_DESTINATION_ENDPOINT=signoz-echo.eagle-atria.ts.net:4317
OTLP_TLS_INSECURE=true
ENVEOF
chown root:signoz-clickhouse /etc/signoz-clickhouse-collector/collector.env
chmod 0640 /etc/signoz-clickhouse-collector/collector.env

echo "--- grants ---"
clickhouse-client --query "SHOW GRANTS FOR monitoring"
echo "--- env file (password redacted) ---"
ls -l /etc/signoz-clickhouse-collector/collector.env
sed 's#//monitoring:[^@]*@#//monitoring:REDACTED@#' \
    /etc/signoz-clickhouse-collector/collector.env
EOF
```

Expected grant — exactly this, nothing more:

```text
GRANT SELECT ON system.query_log TO monitoring
```

### 5.3 What the values mean

| Variable | Value | Why |
|---|---|---|
| `CLICKHOUSE_MONITORING_DSN` | `tcp://monitoring:…@127.0.0.1:9000/` | Loopback only; matches `HOST IP '127.0.0.1'` |
| `CLICKHOUSE_CLUSTER_NAME` | *(empty)* | Single node. The empty-variable warning in the log is expected |
| `QUERY_LOG_SCRAPE_INTERVAL_SECONDS` | `20` | Poll frequency |
| `QUERY_LOG_SCRAPE_DELAY_SECONDS` | `8` | Must exceed the 7500 ms flush interval, else you read rows before they are written |
| `OTLP_TLS_INSECURE` | `true` | Tailscale already encrypts the transport |

---

## 6. Write `config.yaml`

Two host-specific things: `host.name` must be your `HOST_NAME`, and the filter
block is mandatory.

```bash
ssh HOST_ALIAS 'sudo bash -s' <<'EOF'
set -eu
umask 027
cat > /etc/signoz-clickhouse-collector/config.yaml <<'YEOF'
receivers:
  clickhousesystemtablesreceiver/query_log:
    dsn: "${env:CLICKHOUSE_MONITORING_DSN}"
    cluster_name: "${env:CLICKHOUSE_CLUSTER_NAME}"
    query_log_scrape_config:
      scrape_interval_seconds: ${env:QUERY_LOG_SCRAPE_INTERVAL_SECONDS}
      min_scrape_delay_seconds: ${env:QUERY_LOG_SCRAPE_DELAY_SECONDS}

processors:
  filter/clickhouse-slow-queries:
    error_mode: ignore
    logs:
      log_record:
        - 'attributes["clickhouse.query_log.type"] != "QueryFinish"'
        - 'attributes["clickhouse.query_log.query_duration_ms"] < 1000'

  resource/clickhouse:
    attributes:
      - key: service.name
        value: clickhouse
        action: upsert
      - key: host.name
        value: HOST_NAME
        action: upsert

exporters:
  otlp_grpc/clickhouse-query-logs:
    endpoint: "${env:OTLP_DESTINATION_ENDPOINT}"
    tls:
      insecure: ${env:OTLP_TLS_INSECURE}

service:
  pipelines:
    logs/clickhouse-query-logs:
      receivers:
        - clickhousesystemtablesreceiver/query_log
      processors:
        - filter/clickhouse-slow-queries
        - resource/clickhouse
      exporters:
        - otlp_grpc/clickhouse-query-logs
YEOF
chown root:signoz-clickhouse /etc/signoz-clickhouse-collector/config.yaml
chmod 0640 /etc/signoz-clickhouse-collector/config.yaml

grep -A1 'key: host.name' /etc/signoz-clickhouse-collector/config.yaml
EOF
```

Replace `HOST_NAME` with the literal value — the inner heredoc is quoted
(`<<'YEOF'`), so nothing is expanded for you.

### 6.1 How the filter works

Drop-on-match semantics. Each OTTL condition describes records to **throw
away**, and they are OR'd:

```yaml
- 'attributes["clickhouse.query_log.type"] != "QueryFinish"'      # drop QueryStart etc.
- 'attributes["clickhouse.query_log.query_duration_ms"] < 1000'   # drop fast queries
```

Net effect: only `QueryFinish` **AND** `>= 1000 ms` survives. It reads
backwards from intuition — double-check the sign if you edit it.

Why filter here and not in the dashboard? The dashboard already filters on
`>= 1000 ms`, so an unfiltered host still *displays* correctly — but every
fast query is transmitted, indexed, and stored first, then discarded at query
time. Staging ran unfiltered at ~132 events/minute of pure noise, roughly 99%
of all ClickHouse log volume. At the source this is the difference between
shipping 158,157 records a day and shipping 1.

`error_mode: ignore` keeps a record missing those attributes from crashing the
pipeline.

---

## 7. Install the systemd unit

```bash
ssh HOST_ALIAS 'sudo bash -s' <<'EOF'
set -eu
cat > /etc/systemd/system/signoz-clickhouse-collector.service <<'UEOF'
[Unit]
Description=SigNoz ClickHouse slow-query collector
Documentation=https://signoz.io/docs/integrations/clickhouse/
After=network-online.target clickhouse-server.service
Wants=network-online.target

[Service]
Type=simple
User=signoz-clickhouse
Group=signoz-clickhouse
EnvironmentFile=/etc/signoz-clickhouse-collector/collector.env
StateDirectory=signoz-clickhouse-collector
WorkingDirectory=/var/lib/signoz-clickhouse-collector
ExecStart=/opt/signoz-clickhouse-collector/bin/signoz-otel-collector --config=/etc/signoz-clickhouse-collector/config.yaml --copy-path=/var/lib/signoz-clickhouse-collector/config.yaml
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UEOF
chmod 0644 /etc/systemd/system/signoz-clickhouse-collector.service

systemd-analyze verify /etc/systemd/system/signoz-clickhouse-collector.service && echo "unit OK"
EOF
```

- `After=clickhouse-server.service` — start after the database; the collector
  retries anyway if ClickHouse is briefly down
- `StateDirectory=` — systemd creates `/var/lib/signoz-clickhouse-collector`
  with correct ownership; do not mkdir by hand
- `--copy-path` — the collector writes a resolved config there with env vars
  expanded. **That copy contains the password in cleartext**, which is why the
  directory is service-owned
- `NoNewPrivileges=true` — no privilege escalation via setuid
- `Restart=on-failure` — survives transient network or ClickHouse blips

---

## 8. Start it

```bash
ssh HOST_ALIAS '
    sudo systemctl daemon-reload
    sudo systemctl enable --now signoz-clickhouse-collector.service
    sleep 8
    systemctl is-enabled signoz-clickhouse-collector.service
    systemctl is-active  signoz-clickhouse-collector.service
'
```

```bash
ssh HOST_ALIAS \
  'sudo journalctl -u signoz-clickhouse-collector.service -n 30 --no-pager'
```

Want to see:

```text
Everything is ready. Begin running and processing data.
starting system.query_log table scrape
  scrape_interval: 20
  min_scrape_delay: 8
```

Expected and harmless — the variable is intentionally empty on a single node:

```text
Configuration references empty environment variable ... CLICKHOUSE_CLUSTER_NAME
```

Use `-n 30`, not `--since "2 minutes ago"`. A healthy collector logs nothing
after startup, so a narrow window returns `-- No entries --` and looks like a
failure.

---

## 9. Verify end-to-end

Create a slow query deliberately, plus a fast control that must **not** appear.

### 9.1 Issue the markers

```bash
ssh HOST_ALIAS 'sudo bash -s' <<'EOF'
set -eu
set -a; . /etc/echo-analytics/clickhouse.env; set +a
export CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD="$CLICKHOUSE_ADMIN_PASSWORD"
clickhouse-client --query "SELECT sleep(1.6) AS clickhouse_slowlog_MARKER"
clickhouse-client --query "SELECT 1 AS clickhouse_fastlog_MARKER"
echo "markers issued"
EOF
```

### 9.2 Confirm locally first

Separates "ClickHouse logged it" from "the collector shipped it".

```bash
ssh HOST_ALIAS 'sudo bash -s' <<'EOF'
set -eu
set -a; . /etc/echo-analytics/clickhouse.env; set +a
export CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD="$CLICKHOUSE_ADMIN_PASSWORD"
sleep 10
clickhouse-client --query "
SELECT type, query_duration_ms, substring(query,1,50)
FROM system.query_log
WHERE event_time >= now() - INTERVAL 5 MINUTE
  AND query LIKE '%MARKER%'
ORDER BY event_time FORMAT TSV"
EOF
```

Both markers appear here — `system.query_log` is unfiltered. Filtering happens
downstream, in the collector.

### 9.3 Confirm it reached SigNoz

Wait 60–90 s (20 s scrape + 8 s delay + export + ingest), then use the SigNoz
**Logs Explorer**:

```text
resource.service.name = 'clickhouse'
  AND resource.host.name = 'HOST_NAME'
  AND attribute.clickhouse.query_log.type = 'QueryFinish'
  AND attribute.clickhouse.query_log.query_duration_ms >= 1000
```

Narrow to your marker by adding:

```text
AND attribute.clickhouse.query_log.query CONTAINS 'MARKER'
```

The UI needs no database credential, which is why it is preferred over
querying the telemetry store directly. If you do need raw SQL, read the DSN
from the SigNoz server's own config on that host — do not copy any credential
into this repo.

### 9.4 Pass criteria

| Check | Expected |
|---|---|
| Slow marker (`sleep(1.6)`) | **present**, `QueryFinish`, ~1601 ms |
| Its `QueryStart` record | **absent** — filtered |
| Fast control (`SELECT 1`) | **absent** — filtered |

Slow marker missing but service healthy? It probably landed inside the first
scrape window. Wait 60 s and re-check, or issue another marker. This happened
on ZP2 and was a false alarm.

### 9.5 Compare all hosts

In the Logs Explorer, filter `resource.service.name = 'clickhouse'` over the
last 30 minutes and group by resource `host.name` plus
`attribute.clickhouse.query_log.type`.

Every host should show `QueryFinish` only, with no duration below 1000 ms. A
`QueryStart` row or a sub-1000 ms duration means that host's filter is missing
or misconfigured.

---

## 10. Rollback

```bash
ssh HOST_ALIAS '
    sudo systemctl disable --now signoz-clickhouse-collector.service
    sudo rm -f /etc/systemd/system/signoz-clickhouse-collector.service
    sudo systemctl daemon-reload
    sudo rm -rf /etc/signoz-clickhouse-collector \
                /opt/signoz-clickhouse-collector \
                /var/lib/signoz-clickhouse-collector
    sudo userdel signoz-clickhouse
'
```

```bash
ssh HOST_ALIAS 'sudo bash -s' <<'EOF'
set -eu
set -a; . /etc/echo-analytics/clickhouse.env; set +a
export CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD="$CLICKHOUSE_ADMIN_PASSWORD"
clickhouse-client --query "DROP USER IF EXISTS monitoring"
EOF
```

```bash
ssh HOST_ALIAS 'systemctl is-active clickhouse-server.service'
```

**Never** restart or reconfigure `clickhouse-server` as part of collector
rollback. Nothing here touches ClickHouse's own config — only a user account
is added.

---

## 11. Post-install

- Record the host in the rollout document
- Confirm the dashboard's ClickHouse panel groups by **Resource →
  `host.name`**, not the plain `host` tag. Grouping by `host` yields
  `{host=""}` because ClickHouse telemetry carries the hostname as a resource
  attribute
- Optionally save a Logs Explorer view using the step 9.3 filter

Sites with no ClickHouse deployed never appear in the panel. That is expected,
not a gap.

---

## 12. Troubleshooting

**Service restart-loops.** Read the journal — usually a config typo or a
ClickHouse auth failure:

```bash
ssh HOST_ALIAS 'sudo journalctl -u signoz-clickhouse-collector.service -n 50 --no-pager'
```

**`Authentication failed` (Code 516).** The DSN password does not match the
stored hash. Remove the env file, `DROP USER monitoring`, and re-run §5.2 —
password and hash must be generated together.

**`address already in use` when testing by hand.** The running service holds
metrics port `:8888`. **Not** a config error — it means parsing and component
construction succeeded. Stop the service first for a clean foreground run.

**`-- No entries --` from journalctl.** A healthy collector is silent after
startup. Use `-n 30` instead of a narrow `--since` window.

**No data in SigNoz, service healthy.** Check in order: is `signoz-echo:4317`
reachable; is there actually a query over 1000 ms in the window; is
`host.name` spelled correctly in `config.yaml`.

**Everything arrives, including fast queries.** The filter is not in the
pipeline. `filter/clickhouse-slow-queries` must appear in *both* the
`processors:` block and the pipeline's `processors:` list — defining it
without listing it silently does nothing.

---

## References

- https://signoz.io/docs/integrations/clickhouse/
- https://signoz.io/docs/opentelemetry-collection-agents/vm/install/
