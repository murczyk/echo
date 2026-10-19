# Indexed inbox count access plans (#3780)

Measured on 2026-10-19 against the existing `echo-pivnich` PostgreSQL 18.4
source, without application, schema, or configuration changes. Catalog row
estimates were 33,174,328 `signal_message_group` rows, 26,163,808
`signal_message` rows, and 19,815,070 `sigint_inbox_item` rows. These are live
production distributions, not a synthetic fixture.

The comparison isolates the access predicate changed between `553c3a793` and
`83adeff54`. The surrounding SQL was captured from
`build_inbox_digest_query` by running the existing inbox-window regression on
the isolated local test database. It retains the `IndexedDigest` lateral
message lookup, deletion predicates, `COUNT(*)`, `MIN(timestamp)`, and both
sets of date predicates. Only the allowlist, dates, and access predicate were
substituted for the production diagnostics. No search, facet, or cursor
filters were selected.

## Method

Each statement ran sequentially with `default_transaction_read_only=on`, a
five-second `statement_timeout`, and a 500-ms `lock_timeout`. Plain
`EXPLAIN (VERBOSE, FORMAT JSON)` was captured before each variant's first
execution. Measurements used:

```sql
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON, FORMAT JSON) ...;
```

All periods end inclusively at `2026-10-19 00:00:00` UTC. Their inclusive
starts are one hour, one day, or seven days earlier. The allowlists are
diagnostic scopes taken from `pg_stats.most_common_vals`, not a replay of a
particular user's request: the first 100, four, two, or one keys, plus the
100th key alone. The original private keys are consistently replaced with
`G001` through `G100` in the [retained plans](3780-inbox-access-plans.txt).

Each pair ran three times, alternating before/after, after/before,
before/after. No cache flush, planner disabling, or `ANALYZE` was performed.
The source had `random_page_cost=1.1`, `work_mem=8MB`, and JIT enabled.
Application count SQL contains rendered literal values; these measurements
also used literal SQL rather than generic prepared plans.

## Results

Times below are medians of three completed executions. Hit/read counts are
the whole query's shared buffer counts from the corresponding median run;
they are not distinct pages. A timeout produced no actual plan or complete
buffer count, so those values are left absent. All completed runs had zero
temporary reads and writes.

| Scope | Before ms | Message-first ms | Before shared hit/read | Message-first shared hit/read |
| --- | ---: | ---: | ---: | ---: |
| 100 groups, 1 hour | 292.905 | 9.843 | 235,068 / 0 | 10,741 / 1 |
| 100 groups, 1 day | 5,000-ms timeout, 3/3 | 823.156 | — | 811,063 / 268 |
| 100 groups, 7 days | 5,000-ms timeout, 3/3 | 5,000-ms timeout, 3/3 | — | — |
| 4 groups, 1 day | 1,280.611 | 793.360 | 1,487,581 / 1 | 828,679 / 0 |
| 2 groups, 1 day | 807.166 | 671.360 | 1,031,869 / 0 | 834,405 / 0 |
| 1 most-common group, 1 day | 692.695 | 772.426 | 756,077 / 0 | 872,442 / 0 |
| 1 less-common group, 1 day | 913.974 | 874.605 | 753,441 / 4 | 909,067 / 150 |

The old lookup selected
`signal_message_group_group_master_key_signal_message_id_idx`; the candidate
selected `signal_message_group_signal_message_id_group_master_key_idx`.
Both are existing covering btree indexes. The latter uses
`signal_message_id = signal_message.id` as its index condition, then applies
the group filter outside the `OFFSET 0` subquery.

| Scope | Group scan loops, both variants | Before index searches | Message-first index searches |
| --- | ---: | ---: | ---: |
| 100 groups, 1 hour | 956 | 56,867 | 956 |
| 4 groups, 1 day | 71,385 | 249,459 | 71,385 |
| 2 groups, 1 day | 71,385 | 139,103 | 71,385 |
| Either single group, 1 day | 71,385 | 71,385 | 71,385 |

The correlated scan still runs once per candidate message. The improvement
is fewer index searches within each scan, not fewer outer loops. For the
100-group hourly request, all three old executions took 290.649–304.115 ms;
all three candidate executions took 9.515–11.581 ms. The one-day candidate
took 643.331–1,162.089 ms while all three old executions timed out.

## Single-group safeguard

A single allowed group has no repeated per-group searches to eliminate.
For the most-common single group, forcing message-first access increased
group-index heap fetches from 2,729 to 138,728 and total shared buffer hits
by about 15%, with an approximately 12% slower median. The less-common
single-group candidate also increased buffer work despite a slightly faster
median. The retained single-group candidate plans document this rejected
behavior.

The final helper therefore uses the inner message-first barrier only when
`lookup_by_message` is true and there is more than one allowed group. For
one group it preserves the original correlated `EXISTS`, including its
outer `OFFSET 0`. Empty allowlists still return `FALSE`. Other query purposes
retain their existing unbarriered access predicate. No index or migration
is needed.

The existing database-backed
`issue_3780_message_group_lookup_preserves_access_and_scope` regression covers
single and multiple allowed keys, duplicate memberships, denied and null
memberships, empty allowlists, and lower-bound, inclusive, and empty ID
scopes. The existing inbox-window regression verifies exact before/after
message counts. Read-only repeatable-read comparisons also returned identical
counts and first timestamps for the production 100-group hourly and
two-group daily cases.

## Reproduce and operational limits

Use [the SQL script](3780-inbox-access.sql) with connection details and a
private PostgreSQL `text[]` authorization scope supplied separately:

```bash
psql "$SOURCE_DSN" -X \
  -v message_first=true \
  -v allowed_groups="$ALLOWED_GROUPS" \
  -v since='2026-10-18 23:00:00' \
  -v till='2026-10-19 00:00:00' \
  -f docs/query-plans/3780-inbox-access.sql
```

Repeat with `message_first=false` for the pre-branch shape. The script runs
plain and actual plans inside a read-only transaction with the same timeouts.
Its custom prepared plans expose the supplied constants to the planner like
the application's rendered SQL. `true` deliberately selects the candidate
shape even for one key so the rejected single-group behavior remains
reproducible; the final application uses the old shape for that case.

Cache warming and concurrent ingestion affect these live measurements. They
are diagnostic query timings, not concurrent endpoint p95 or a latency SLA.
Both seven-day variants exceeded the diagnostic limit, so this evidence does
not establish a seven-day latency improvement or justify changing the
existing seven-day strategy boundary.

Canary the application change and compare matched count-request windows,
timeouts, `pg_stat_statements` execution time and shared blocks, source I/O,
and ingestion/replication lag before wider rollout. Revert the application
if common workloads regress; no schema rollback or analytics resync is
required.
