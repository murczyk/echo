# ClickHouse Collector — Install Checklist

Commands: **[CLICKHOUSE_COLLECTOR_COMMANDS.md](CLICKHOUSE_COLLECTOR_COMMANDS.md)**

Fill in first:

```text
HOST_ALIAS   echo-<site>-clickhouse
HOST_NAME    ct-echo-<site>-clickhouse
MARKER       verify_<site>_<date>
```

---

1. Pre-flight check — [§1](CLICKHOUSE_COLLECTOR_COMMANDS.md#1-pre-flight-check)
2. Baseline volume — [§2](CLICKHOUSE_COLLECTOR_COMMANDS.md#2-baseline-query-volume)
3. Transfer binary — [§3](CLICKHOUSE_COLLECTOR_COMMANDS.md#3-transfer-the-binary)
4. Create OS user — [§4](CLICKHOUSE_COLLECTOR_COMMANDS.md#4-create-the-os-user)
5. Create ClickHouse user — [§5](CLICKHOUSE_COLLECTOR_COMMANDS.md#5-create-the-clickhouse-user-and-env-file)
6. Write config.yaml — [§6](CLICKHOUSE_COLLECTOR_COMMANDS.md#6-write-configyaml)
7. Install systemd unit — [§7](CLICKHOUSE_COLLECTOR_COMMANDS.md#7-install-the-systemd-unit)
8. Start service — [§8](CLICKHOUSE_COLLECTOR_COMMANDS.md#8-start-it)
9. Verify end-to-end — [§9](CLICKHOUSE_COLLECTOR_COMMANDS.md#9-verify-end-to-end)
10. Record rollout — [§11](CLICKHOUSE_COLLECTOR_COMMANDS.md#11-post-install)

Broken? [§12](CLICKHOUSE_COLLECTOR_COMMANDS.md#12-troubleshooting) ·
Undo? [§10](CLICKHOUSE_COLLECTOR_COMMANDS.md#10-rollback)

---

## Stop if

- **3** — checksum differs
- **5** — more than one grant line
- **6** — wrong `host.name`, or filter missing from the pipeline list
- **9** — a `QueryStart` row, or any duration under 1000 ms

---

## Expect

Only `QueryFinish` at 1000 ms or more is exported, so a quiet host sends
nothing for days. Step 9's `sleep(1.6)` marker is the only liveness signal.

The filter is inverted: conditions list what to **drop**.

---

## Secrets

Nothing is written here or passed on a command line.

- ClickHouse `default` password — sourced from
  `/etc/echo-analytics/clickhouse.env` on the host
- `monitoring` password — generated on the host, stored only in
  `collector.env` (`0640`); SQL gets the sha256 hash, so it never enters
  `system.query_log`
- SigNoz telemetry-store password — not needed; step 9 uses the Logs
  Explorer UI
