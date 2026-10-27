# Posts product exclusion plans (#3864)

Measured on 2026-10-22 against `echo-pivnich` and its configured analytics
gateway, both PostgreSQL 18.4. The existing `NOT EXISTS` change uses indexed
product lookups on PostgreSQL and a pushed-down ClickHouse anti-join. No
additional query or index change is needed for this predicate.

The source catalog estimated 26,676,642 `signal_message` rows, 20,218,296
`sigint_inbox_item` rows, and 1,302,164 `intel_product` rows. The completed old
plan actually read 1,334,661 product links. These are production distributions.
Application code, schema, configuration, and services were not changed on
either host.

## Query and parameters

The SQL was captured from `load_post_report_messages` while running
`issue_3864_posts_report_excludes_products_and_keeps_sources` on an isolated
local database. Temporary logging was removed afterward. The comparison
retains the four projected fields, all joins, deletion predicate, authorization
and selected-group predicates, enum-to-text cast, and both pairs of date
predicates. Only the product exclusion changes between `NOT IN` and
`NOT EXISTS`. No search or other optional filters were selected.

Current range: `2026-10-21 00:00:00` through `2026-10-22 00:00:00` UTC.
Previous range: the same bounds shifted back one day. Upper bounds are
inclusive, matching a final report chunk. Twenty-four hours is the default
chunk size; the whole report repeats this work for every chunk in both ranges.

The broad diagnostic scope uses the first 100 keys from
`pg_stats.most_common_vals` for `signal_message_group.group_master_key` as
both the authorization and selected-group arrays. The narrow scope uses the
98th key, confirmed active in the current range. These are diagnostic scopes,
not a replay of a particular user's permissions. Private keys are redacted as
`G001` through `G100`; the narrow scope is `G098`.

## PostgreSQL results

Every connection had `default_transaction_read_only=on` and a 500-ms lock
timeout. Plain `EXPLAIN (VERBOSE, SETTINGS)` preceded execution. Actual plans
used `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON, VERBOSE, SETTINGS)`.
Existing settings included `work_mem=8MB`, `random_page_cost=1.1`, and JIT on.
No statistics refresh, cache flush, or planner disabling was performed.

| Scope | Old ms | New ms | Returned rows | Old shared hit/read | New shared hit/read |
| --- | ---: | ---: | ---: | ---: | ---: |
| G098, current 24 hours | 571.375 | 195.066 | 515 in both | 88,605 / 15,324 | 88,353 / 367 |
| 100 groups, current 24 hours | 30,000-ms timeout | 5,315.279 | 67,554 new | unavailable | 1,505,602 / 11,176 |
| 100 groups, previous 24 hours | 5,000-ms timeout | 4,954.559 | 63,642 new | unavailable | 1,414,354 / 8,520 |

The narrow timings are medians of three pairs, ordered old/new, new/old,
old/new. All six executions returned 515 rows and used the same scope
fingerprint. Old times were 1,743.210, 571.375, and 494.743 ms; new times were
195.066, 1,614.376, and 172.170 ms. Buffer counts are from each variant's
median execution. The ranges overlap: cache state, concurrent production
activity, and I/O affect latency.

The broad old query exceeded three initial five-second attempts in each
range. Current-range retries also exceeded 15 and 30 seconds. The new current
range exceeded all three initial five-second attempts, then completed with a
15-second limit. The new previous range completed one of three five-second
attempts. Broad successful timings are individual observations, not medians.
Cancellation returns no actual plan or complete buffer counts; the retained
old broad plans are explicitly labeled plain plans.

The old narrow plan builds a hashed subplan by scanning all 1,334,661 product
links once. The broad old plain plan additionally scans
`signal_message_babak_candidate_stream_idx` without a message-ID or date
index condition, then hash-joins the date-filtered inbox rows. Its estimated
13,022 product links materially underestimate the actual product scan.

The new plans start with the bounded inbox date index and use
`Nested Loop Anti Join` with `intel_product_pkey`:

```text
Index Cond: (intel_product.intel_message_id = signal_message.id)
```

The key already starts with `intel_message_id`. Product index searches and
loops were exactly 515 for G098, 67,554 for the broad current range, and
63,642 for the broad previous range. The new product branch has no sequential
scan or correlated `SubPlan`; it performs one indexed existence probe per
candidate, stopping at the first qualifying link. The completed plans report
no temporary I/O. The functional regression separately verifies exclusion of
both comment and report products while retaining their sources.

## Analytics gateway

Actual plans through the configured application role, `echo_analytics`, were:

| Scope | New ms | Returned rows | Foreign-scan loops |
| --- | ---: | ---: | ---: |
| 100 groups, current 24 hours | 1,592.973 | 67,554 | 1 |
| 100 groups, previous 24 hours | 1,405.756 | 63,642 | 1 |

Each entire query is one `Foreign Scan`. Its `Relations` and `Remote SQL`
include `LEFT ANTI JOIN echo_analytics.intel_product`, with both the
`intel_message_id` equality and relation-kind restriction in `ON`. The date
and group filters also appear in that remote SQL. There is no PostgreSQL
product subplan or per-candidate remote rescan. The old plain gateway plan
pushes its `NOT IN` subquery into the remote SQL as well; no old/new gateway
latency comparison is claimed.

Pushdown does not imply that ClickHouse reads only candidate product IDs:
the remote join can still scan/build its right side once per chunk. Gateway
PostgreSQL buffer counts do not measure ClickHouse read bytes or join memory.
These results establish set-based execution, not a memory or concurrency SLA.

## Reproduce and limits

Full median narrow plans, broad plain plans, broad successful actual plans,
timeout results, and gateway remote SQL are in
[the captured plans](3864-posts-anti-join-plans.txt). The
[diagnostic SQL](3864-posts-anti-join.sql) preserves the query and wraps plain
and actual plans in a read-only transaction:

```bash
psql "$SOURCE_DSN" -X \
  -v anti_join=true -v allowed_groups="$ALLOWED_GROUPS" \
  -v since='2026-10-21 00:00:00' -v till='2026-10-22 00:00:00' \
  -f docs/query-plans/3864-posts-anti-join.sql
```

Supply the private allowlist as a PostgreSQL `text[]`. Repeat with
`anti_join=false` for the old query, use the previous dates for the shifted
range, or connect with the application's gateway role to inspect pushdown.
The default timeout is five seconds; `-v timeout_ms=30000` reproduces the
extended old current-range limit. Production measurements used rendered
literals; the script forces custom prepared plans to expose the same values.
Both authorization predicates intentionally remain, matching the captured
request with selected groups equal to its allowlist.

These measurements cover candidate scans, not network enrichment, document
rendering, concurrent report workers, or every optional filter. Broad source
fallback remains expensive, and a failed gateway attempt can precede a full
PostgreSQL retry of both ranges. The indexed anti-join does not bound total
report duration independently of the number of candidates and chunks. Monitor
matched report durations, fallback/timeouts, source buffer reads, and
ClickHouse query memory/read rows before treating this as a latency guarantee.
