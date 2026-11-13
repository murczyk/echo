# Network cleanup activity recheck (#4093)

Captured locally on 2026-11-09 with
`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)`, JIT disabled, and a
120-second statement timeout. Temporary tables copied the migrated test
database's column definitions and indexes. All fixture data was rolled back.
These synthetic plans demonstrate access paths, not production latency.

The fixture contained 20,000 networks, 200,000 frequencies, and 1.2 million rows
in each of `signal_message`, `sigint_inbox_item`, and
`sigint_inbox_item_network`. One million messages were distributed across the
frequencies; an additional 200,000 old messages belonged to ten frequencies of
one dense network. Ten percent of inbox datetimes were null. About 200,000
unrelated messages had recent datetimes, while both selected networks had only
old activity. Statistics were refreshed before each comparison.

The queries were the worker's frequency-ID-scoped eligibility recheck and its
network-ID-scoped grace lookup. Both eligibility variants returned the selected
inactive frequency. The original single activity subquery combined datetime,
timestamp, and creation-time fallback with `OR`.

The full candidate scan retains that combined subquery. On the same fixture,
both strategies found 160,004 candidates, but splitting the full scan increased
execution time from 814.476 ms to 1,113.685 ms and temporary reads from 14,214
to 16,881 blocks: the undated branch added another message-table scan. Split
probes are therefore limited to the locked frequency-ID subset.

| Case | Combined activity probe | Split dated/undated probes |
| --- | ---: | ---: |
| Sparse inactive frequency | 1.970 ms | 0.379 ms |
| Dense inactive frequency | 11.838 ms | 0.093 ms |
| Fresh frequency present | 0.020 ms | 0.021 ms |
| Fresh frequency absent | 0.012 ms | 0.009 ms |

The original dense probe used a frequency-only bitmap lookup and filtered
20,005 old inbox rows. The split dated probe instead used the existing partial
`(freq, datetime) INCLUDE (id) WHERE datetime IS NOT NULL` index:

```text
Index Cond: ((freq = sigint_network_freq.freq)
             AND (datetime >= '2026-10-30 12:00:00'))
actual rows=0 loops=1
```

The undated probe used the existing partial `(freq, id) WHERE datetime IS NULL`
index; message timestamp and creation time retain their original fallback
semantics. An undated frequency with extensive history can still require
examining its undated rows. The existing functional regressions cover activity
with all three timestamp sources and changes after candidate selection.

Both rechecks first locate frequency/network rows through their primary keys.
The grace lookup uses `sigint_network_freq_network_id_idx` with
`Index Cond: (network_id = ...)` and `LIMIT 1`; the absent case inspected only
the selected network's ten frequencies. No new index or migration is needed.
Location cleanup uses one ordered, frequency-scoped locking query per network,
rather than a scan per frequency; `freq_location` currently has no frequency
index, so its scan cost still depends on the location catalog size.

After an approved rollout, compare read-only plans and short
`pg_stat_statements` deltas for real sparse, dense, and undated frequencies.
Check frequency/time index conditions, buffer reads, lock duration, and worker
progress before considering any further index or batching change. Existing
production cardinalities and the dated/undated index rationale are recorded in
[the frequency-count plans](network-frequency-counts.md).
