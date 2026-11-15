# Daily message statistics query validation (#3873)

Both modes read creation-time rows from PostgreSQL through the existing read
admission and deadline mechanism. The allowed group set is resolved before the
query. Group pages select their stable keys first and constrain message links to
that page; sender pages discover identities only within authorized associations.
Unit filters use EXISTS to avoid multiplying rows. All measures are exact
COUNT(DISTINCT), including the explicit unknown-sender bucket.

A local PostgreSQL projection used 1,000,000 messages distributed across ninety
days, 2,000,000 group associations, 100 groups, 1,000 sender identities and unknown
senders. Each message had two group links. The caller could access ten groups;
series pages contain ten entities plus a lookahead. Projection indexes included
message `created_at`, association `(group_master_key, signal_message_id)`
and association `(signal_message_id, group_master_key)`, matching existing
migrations. Empty user/profile tables and 100,000 imported sender-name rows
exercised name fallbacks. Imported names are grouped in one set-based join,
avoiding a repeated scan for each sender identity.

The production query templates were used with `EXPLAIN (ANALYZE, BUFFERS,
TIMING OFF, SUMMARY ON)`, 32 MB work memory and a 30-second statement timeout.
Measured execution times during concurrent local compilation:

| Days | Group mode | Sender mode |
| --- | --- | --- |
| 1 | 119 ms | 167 ms |
| 7 | 637 ms | 183 ms |
| 90 | 2884 ms | 950 ms |

Group-mode equality joins avoid repeatedly scanning the materialized eligible
associations for each series. Sender mode joins both nullness and normalized
key value, preserving the unknown bucket while allowing a hash join rather
than rescanning eligible associations for every page entry. All six executions
completed under the existing timeout.
At ninety days, 198,889 eligible associations were materialized once. Hashes
stayed in one batch and no temporary spill was reported. The broad period used
sequential source scans, while narrower periods used the creation-time index.
The final group join estimated 9,895 rows versus 198,889 actual rows, so the
timings do not substitute for checking a deployed server's plan.

With access widened to all 100 groups, ninety-day group and sender queries
took 2978 ms and 7486 ms respectively. Sender mode materialized 1,988,896
eligible associations and spilled about 95 MB to disk with 32 MB work memory.
Broad authorized scopes therefore remain materially more expensive than group
pages; they retain the same deadline and explicit error/retry behavior.
The temporary projection and its inserts were rolled back after measurements.

These results validate a source access path at the stated cardinalities; they
are not deployment measurements or a latency guarantee for a particular server.
Real group distributions, table width, concurrent load and unit selections can
change plans. The page reports timeouts as errors and never silently shortens
periods or drops series. Existing Redis/HLL statistics and the frequency-only
legacy daily endpoint are not part of this implementation.

Filter counters use the same eligible-message predicate. Group options count
distinct message IDs per group; unit options join the shared hierarchy's
canonical descendant IDs and count distinct messages per selectable scope.
Unit links, repeated association kinds and messages shared across groups do not
multiply subtree counts. The unassigned option excludes messages with any
active unit link. Empty scopes retain zero counts.

Before the lazy-filter optimization, the unit-counter SQL was run with `EXPLAIN (ANALYZE,
BUFFERS, TIMING OFF)` on the isolated local lab containing 240,000 messages over
120 days, 272,913 group associations and 124 canonical units. A scope of 69
accessible groups returned 126 selectable counters in 1,142 ms for seven days
and 5,132 ms for ninety days, with 32 MB work memory while Rust compilation was
running. These are local measurements, not a production latency guarantee.


## Lazy filter queries and short cache

The chart and legacy `/options` responses remain compatible. The page now uses
three independent resources below `/api/rer/analysis/stats/daily-messages`:

- `/catalog`: accessible group labels, hierarchy only when its revision differs,
  and authorized labels for selected senders.
- `/facet-counts`: exact group or unit counters, excluding that facet's own
  selection. Group and unit queries never calculate one another's counters.
- `/senders`: distinct eligible identities, labels, an exact total before search,
  and stable 50-entry keyset pages. No per-sender message counts are calculated.

Unit counters first materialize eligible message IDs through an authorized
association semi-join. Active unit links are deduplicated by message and unit;
integer hierarchy scopes then deduplicate message/scope pairs before `COUNT(*)`.
The unknown bucket uses an anti-join against active links. This preserves exact
subtree counts for overlapping group links, unit association kinds, and children.
Optional unit and sender predicates are emitted only when selected.

Successful facet and sender responses share a bounded process-local cache:
five seconds, 128 entries plus in-flight keys, and a 256 KiB payload limit.
Current base-role and group authorization run before every lookup. Keys include
source pool, login, effective group access, normalized remaining filters and,
for unit counts, hierarchy revision and descendant choice. Empty selections stay
distinct from absent filters. Concurrent identical requests share the result;
errors are not cached. SQL runs in the leader HTTP request's existing read-query
context. Cancelling a follower leaves the leader running; a cancelled leader
releases the key and lets a follower retry under its own admission and deadline.
Capacity overflow bypasses persistence through normal read admission. No Redis,
ClickHouse, aggregation tables or schema changes are required.

The `analytics_route` log stage `daily_stats_facet` records the facet, elapsed
milliseconds and cache disposition (`miss`, `hit`, `wait`, `bypass`). Local
measurements below should be interpreted separately from deployed behavior.


Five alternating paired executions of the old and implemented unit-counter
prepared templates used `force_custom_plan`, the same 240,016-message lab,
69 accessible groups, 8 MB work memory and a 15-second statement timeout.
Concurrent Rust builds were running on the host; these are relative query
comparisons rather than an idle-host benchmark.

| Period | Previous median | Optimized median | Previous / optimized |
| --- | --- | --- | --- |
| 7 days | 1,432 ms | 516 ms | 2.8x |
| 90 days | 5,338 ms | 1,817 ms | 2.9x |

The seven-day query stopped writing temporary blocks (734 to zero). The
ninety-day query reduced temporary writes from 6,900 to 5,900 blocks and still
spills at this work-memory setting. Absolute 250/800 ms lab targets were not
reached during these concurrent builds; performance depends on available CPU,
source cardinality and PostgreSQL settings.


Five HTTP repetitions per case included fresh authorization on every request.
Each round waited beyond the five-second TTL; the immediate repeat reused the
same response and generation time. These unit scopes differ between cases, so
the first calls below computed new results. PostgreSQL buffers were not flushed.
Clippy checks and frontend builds were active during measurements.

| Unit counters | First request median | Immediate repeat median |
| --- | --- | --- |
| 7 days, no filters | 401 ms | 50 ms |
| 7 days, one group | 99 ms | 36 ms |
| 7 days, combined filters | 121 ms | 40 ms |
| 90 days, no filters | 1,640 ms | 54 ms |
| 90 days, one group | 357 ms | 46 ms |

Full catalog metadata took a median 43 ms over five requests. Group counters
intentionally reuse an equivalent cached scope when only their own group
selection changes; their first call in a sequence is therefore not necessarily
a source-query measurement.

Nine Orca navigations against the current local production frontend (three per
case) made exactly two statistics requests each: chart and catalog. No closed
filter requested counts or sender pages. Median all-data/first-chart times were
601/658 ms for seven days without filters, 461/494 ms with combined filters, and
1,108/1,332 ms for ninety days. These are end-to-end browser observations during
concurrent checks, not isolated server timings or a deployment benchmark. The
shared development JavaScript startup remains outside this optimization.


After the Rust and frontend checks exited, the same five alternating prepared
query pairs were repeated on the same lab, with unchanged data and PostgreSQL
settings and warm buffers:

| Period | Previous median | Optimized median | Previous / optimized |
| --- | --- | --- | --- |
| 7 days | 361 ms | 101 ms | 3.6x |
| 90 days | 2,095 ms | 475 ms | 4.4x |

The optimized ranges were 97–107 ms and 464–491 ms respectively. The 250/800 ms
lab targets were met after compilation finished. The HTTP and browser tables
above describe their original concurrent-check conditions.
