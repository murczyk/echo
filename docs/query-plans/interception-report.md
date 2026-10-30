# Interception report query plans

Production comparison for [PR #3924](https://github.com/echoua/echo/pull/3924),
captured on 2026-10-30. The baseline is the report query before `e9e3845e4`
(`7299bdcc3`); the candidate uses the materialized ID CTE and lateral primary-key
lookup in `e9e3845e4`. A follow-up comparison below covers the indexed group and
product lookups implemented in this change.

## Workload and method

Measured on `echo-skhid`, database `wd`, PostgreSQL 18.4. Approximate live-row
counts from `pg_stat_user_tables` at 07:57 UTC, before the completed comparison:

| Relation | Estimated live rows |
| --- | ---: |
| `signal_message` | 39,501,847 |
| `sigint_inbox_item` | 33,376,169 |
| `signal_message_group` | 42,452,954 |
| `sigint_inbox_item_tag` | 36,445,654 |
| `sigint_comment` | 1,635,142 |
| `intel_product` | 1,574,287 |

Both variants used the same saved report parameters: one selected group, 11 selected tags,
identity group access restrictions, interception datetime ordering,
`or_with_extended_form = true`, `without_model_tags = true`, and
`report_tags_only_this_unit = true`, without analytics candidate IDs.
The UTC window was `[2026-10-27 22:04, 2026-10-28 10:04)`, matching a report
chunk boundary. Both queries included the complete report projection and
aggregation.

Plain `EXPLAIN (FORMAT JSON)` preceded each execution. Each measurement used a
separate connection with the following transaction settings and unchanged
server planner settings (`jit = on`, `work_mem = 8 MiB`, `shared_buffers = 8 GiB`,
`max_parallel_workers_per_gather = 2`):

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '1800s';
SET LOCAL lock_timeout = '1s';
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON, FORMAT JSON)
-- Baseline or candidate SELECT with identical report parameters.
;
ROLLBACK;
```

The baseline ran at 08:11–08:30 UTC, followed by the candidate at 08:30 UTC.
Both completed within the timeout. Earlier baseline attempts were canceled at
shorter timeouts. These are single completed executions under live load, in
separate snapshots, without cache resets; the baseline and earlier attempts
could warm caches for the candidate.
[Captured plan trees](interception-report-plans.txt) preserve node estimates,
actual rows and loops, index conditions, buffers, sort/hash details, and timings;
SQL string literals are redacted.

## Results

| Query | Execution time | Result rows | Shared hit/read blocks | Temp read/write blocks |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 1,151,579.220 ms | 50 | 79,353,224 / 11,429,945 | 0 / 0 |
| Candidate | 4,203.009 ms | 50 | 149,670 / 32,411 | 520 / 521 |

Times are PostgreSQL `Execution Time`, excluding planning and connection setup.
Buffer counts are root totals; child counters include their descendants and
must not be summed. Blocks are 8 KiB. Shared reads do not distinguish physical
disk reads from operating-system cache hits.

The baseline scanned `signal_message_babak_candidate_stream_idx` once for each
of 163 accessible groups, before the period and selected-group joins narrowed
the rows. The scan removed an average of 75,840 rows per loop. Its extended-form
comment lookup and source-linked product lookup each executed 12,417,182 times.

The candidate CTE returned only IDs (`Plan Width = 8`), with 543 actual rows.
Its period lookup used `sigint_inbox_item_datetime_id_idx`, reading 59,066 rows
with both period bounds in `Index Cond`. The lateral message lookup used
`signal_message_pkey` with `Index Cond: (id = interception_report_candidates.id)`
for exactly 543 loops. The extended-form comment and source-linked product
lookups likewise ran 543 times, downstream of candidate selection. The actual
plans therefore show the expensive correlated work being narrowed to the
period/group candidates.

In that candidate, selection reads 353,054 historical group links and spills its
ID sort to disk (4,160 KiB). Linked-report exclusion still
scans approximately 1.67 million `intel_product` rows once per query through a
parallel subplan in both variants. Candidate estimates were 100 versus 543
actual rows, and the product subplan estimated 15,683 versus about 1.67 million.
Wider periods, more selected groups, and other filters need their own
representative measurements; the time-bound CTE has no fixed row cap. These
executions establish the access-path improvement for this workload, without
establishing a general speedup ratio or sustained behavior under repeated load.

Both completed plans produced 50 rows; `EXPLAIN` does not compare their values.
Earlier saved equivalence checks returned identical canonicalized rows in this
window (50) and the next report chunk (79). Those checks restricted the baseline
to candidate IDs and normalized tag-array ordering; they validate downstream
results for that ID set, without proving unrestricted baseline completeness.

## Follow-up: indexed group and product lookups

The report now checks group membership by the ID from the relation carrying the
period filter: `sigint_inbox_item` for interception time, `signal_message` for
creation time or message timestamp. Correlated subqueries retain `OFFSET 0` so
the planner cannot turn them into scans of historical membership. Multiple
selected groups are filtered outside the message-ID lookup, avoiding a separate
index probe per group. Group access, sender/login fallback, and matching group
and sender on the same membership row are preserved.

Linked-product exclusion uses a correlated `NOT EXISTS` lookup on
`intel_product.intel_message_id`, retaining the comment/report relation filter.
That column is part of the non-null primary key, so this preserves the previous
`NOT IN` exclusion semantics, including products linked to multiple sources.

The following paired measurements ran at 08:48 UTC on the same production
database, with the same parameters and unchanged planner settings. The first
window is the one above; the second is
`[2026-10-28 10:04, 2026-10-28 22:04]`. Plain `EXPLAIN` preceded execution.
Each old/new pair shared a `REPEATABLE READ READ ONLY` transaction with a
30-second statement timeout and 1-second lock timeout, followed by `ROLLBACK`.
The first pair ran before then after; the second ran after then before. All
four complete actual plans are included in the linked plan trees.
An additional before/after pair at 08:54 UTC used the first window with the
selected group plus one other permitted group, exercising the multiple-group
lookup under the same transaction and timeout settings.

| Window | Query | Execution time | Result rows | Shared hit/read blocks | Temp read/write blocks |
| --- | --- | ---: | ---: | ---: | ---: |
| First | Before (`e9e3845e4`) | 4,246.035 ms | 50 | 142,040 / 39,831 | 520 / 521 |
| First | After | 1,623.396 ms | 50 | 331,343 / 788 | 0 / 0 |
| Second | Before (`e9e3845e4`) | 2,522.487 ms | 79 | 186,397 / 25 | 520 / 521 |
| Second | After | 1,962.759 ms | 79 | 326,874 / 1,284 | 0 / 0 |
| First, two groups | Before (`e9e3845e4`) | 2,306.823 ms | 50 | 428,534 / 30,454 | 0 / 0 |
| First, two groups | After | 1,758.355 ms | 50 | 401,632 / 632 | 0 / 0 |

Membership now uses
`signal_message_group_signal_message_id_group_master_key_idx`, with message ID
and selected group in `Index Cond`, once for each period-index row: 59,066 and
57,006 probes. Candidate selection returns 543 and 525 IDs; wide message
lookups remain downstream. Product exclusion uses `intel_product_pkey` for
exactly 543 and 525 probes, replacing the full product scan. Both queries have
zero temporary I/O. The candidate estimates are 5,500/5,507 versus 543/525 actual
rows. This trades historical scans and sorting for more shared-buffer hits;
the cache state and concurrent load still limit timing comparisons.
The two-group plan also uses the message-ID-first membership index, with only
message ID in `Index Cond` and group matching outside the lookup. Its 59,066
index searches confirm one probe per period row rather than one per group.

Separate read-only repeatable-read comparisons used the unrestricted before
and after queries for each window. Both directions of `EXCEPT ALL` were empty
after sorting the `inbox_tags` arrays, with 50 and 79 rows respectively. These
establish full-row equivalence between `e9e3845e4` and this follow-up for both
windows; the earlier qualification about the pre-hotfix baseline still applies.
The two-group comparison likewise returned 50 identical canonicalized rows.
The report retains its existing period chunks, per-chunk progress logs, and
record limit. Diagnostic executions are bounded by the statement timeout.
Wider periods, more groups, and sustained load still need their own measurements:
membership probes scale with period rows, and the CTE has no fixed row cap.
