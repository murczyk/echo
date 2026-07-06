# Datasource Group Bloat Incident

Date: 2026-07-05

## Summary

Echo became slower after the PostgreSQL 14 to 18 upgrade window. The main
regression was not caused directly by PostgreSQL 18. PostgreSQL 18 made an
existing bad write/query pattern more visible:

- `datasource_group` had only a few hundred live rows, but occupied about
  67 MB heap / 90 MB total in production.
- The table had hundreds of millions of historical updates.
- The messenger group sync loop rewrote `datasource_group.last_sync_at` and
  `name` for every group sync even when nothing changed.
- The `echo_operator` inbox worker joined through the bloated
  `datasource_group` table while polling an almost always empty queue.

## Evidence

Production `pg_stat_statements` was enabled and reset during the investigation.
After a 10-minute sample, the top query by total time was the old operator
inbox poll:

```text
calls=136 total_ms=637157.7 mean_ms=4685.0 max_ms=21238.9 rows=1
SELECT signal_message.id
FROM signal_message
INNER JOIN datasource_group ...
LEFT JOIN sigint_inbox_item ...
WHERE sigint_inbox_item.id IS NULL
  AND datasource_group.datasource_id = $1
  AND signal_message.created_at <= $2
ORDER BY signal_message.created_at
LIMIT $3
```

The same sample showed the root write source:

```text
calls=650123 total_ms=24277.1
UPDATE datasource_group
SET last_sync_at = $1, name = $2
WHERE datasource_group.id = $3
RETURNING ...
```

Production table stats also confirmed the bloat pattern:

```text
relname=datasource_group
n_tup_upd=704375908
n_tup_hot_upd=475228764
n_dead_tup=2272
heap_size=67 MB
total_size=90 MB
```

Slow logs from `wdintel-rs-bgworker` had repeated 8-15 second instances of the
old operator poll, usually returning zero rows.

## Root Cause

`wdintel-rs/src/messenger/worker/group.rs` updated existing
`datasource_group` rows on every sync:

- `last_sync_at` was always set to `now`.
- `name` was always set even when unchanged.
- deleted rows were marked deleted repeatedly.

Because `datasource_group` is tiny logically, this produced extreme table churn
and physical bloat. The old `echo_operator` worker then depended on that table
in a hot polling query, so the bloated table and generic prepared plans caused
slow empty polls.

## Fix Implemented

Code changes:

- `wdintel-rs/src/messenger/worker/group.rs`
  - Only updates `datasource_group` when `deleted`, `name`, or a 60-minute
    `last_sync_at` touch interval requires it.
  - Adds `deleted = false` restoration only when an update is needed.
  - Avoids repeatedly marking already-deleted rows as deleted.

- `wdintel-rs/src/operator/worker.rs`
  - Replaces the hot join query with:
    - prefetch `datasource_group.id` for the operator datasource,
    - per-group `signal_message` lookup,
    - 3-hour maximum lookback,
    - in-memory merge of the oldest 50 candidate messages.
  - This avoids full-table style scans and avoids the bloated join in the hot
    polling path.

- `wdintel-rs/src/operator/oneoff.rs`
  - Adds `oneoff-compact-datasource-group`.
  - The command prints before/after table sizes and runs:

```sql
VACUUM (FULL, ANALYZE) datasource_group;
```

Migration:

- `echo-migration/src/m20260705_230242_operator_datasource_group_perf.rs`
  - `datasource_group(datasource_id, id)`
  - `signal_message(datasource_group_id, created_at, id)`
  - `stats_group_5min(dt)`

## Dev Validation

On `echo-pivnich-dev`, the old forced generic prepared plan scanned through
`signal_message_created_at_idx` and took up to 138 seconds in one test.

After the per-group query rewrite and the new composite index, the prepared
query used:

```text
Index Only Scan using signal_message_datasource_group_id_created_at_id_idx
Index Cond:
  datasource_group_id = $1
  created_at >= $2
  created_at <= $3
Execution Time: 0.13-0.63 ms in sampled operator groups
```

## Deployment Notes

For production, pre-create the large indexes concurrently before running the
normal migration, so the migration becomes a no-op for those indexes:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS datasource_group_datasource_id_id_idx
    ON datasource_group (datasource_id, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS signal_message_datasource_group_id_created_at_id_idx
    ON signal_message (datasource_group_id, created_at, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS stats_group_5min_dt_idx
    ON stats_group_5min (dt);
```

After deploying the code and restarting the background worker, run the physical
cleanup in a small maintenance window:

```bash
wdintel-rs --mode=live oneoff-compact-datasource-group
```

`VACUUM FULL` takes an exclusive lock on `datasource_group`, but the table has
only a few hundred live rows, so it should be short once the write storm is
stopped.

## Secondary Findings

These were visible in `pg_stat_statements`, but were not the primary
`datasource_group` bloat source:

- `/api/monitoring` repeatedly ran
  `SELECT account_id, MAX(created_at) FROM echo_inbox_message GROUP BY account_id`.
  Consider caching that endpoint or rewriting the query.
- `stats_group_5min` had heavy scans for `dt`-range deletes/reads; the new
  `stats_group_5min(dt)` index is included for that.
- Several analysis/count queries over `signal_message` and inbox joins remained
  expensive and should be profiled separately after the operator fix lands.

## Post-Deploy Follow-Up

After deploying the first fix to `echo-pivnich`, the old operator join query
and repeated `datasource_group` update were gone from the hot path.
`datasource_group` compacted to about 80 kB heap / 200 kB total.

The new top recurring query was:

```sql
SELECT account_id, MAX(created_at) AS last_inbox_at
FROM echo_inbox_message
GROUP BY account_id;
```

It ran about 25 times per second and averaged about 36 ms on production. A
local `/api/monitoring` cache reduces browser/API pressure for this endpoint,
but most calls come from the `echo-im` worker dependency, where
`do_restart_clients_in_invalid_state` calls full `collect_monitoring_data` on
each tick. The best follow-up is an `echo-im` change: use live client data for
restart checks, or cache monitoring data inside the worker.

Logs also showed `session activity queue is full` warnings and repeated bad
password attempts for `echo-operator-151-2` and `echo-operator-151-5`. The
session activity worker was changed to drain and insert bounded Greptime batches
instead of one row per database round trip. The bad operator credentials still
need an operational fix.
