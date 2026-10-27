# Measured historical count/page windows (#3780)

Read-only investigation on `echo-skhid`, 27 October 2026, following the
[accepted decision and measurement plan](decision.md). Windowing has not been
implemented. The installed package remained the previously inspected
`0.1.1~rc.202610261229-1`; no deployment, index/statistics refresh, service,
configuration, application data, analytics metadata or cache state was changed.
Sanitized evidence is in [measurements.json](measurements.json).

## What was measured

There were **83 timed EXPLAIN probes: 61 completed and 22 reached the eight-second
statement budget**. Additional SELECT checks verified distinct-key unions and
page ordering. Each query used its own read-only transaction, one diagnostic
query at a time, a one-second lock timeout and an eight-second statement limit.
Plans used `ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON, FORMAT JSON`; timings below
are SQL execution, excluding planning, HTTP, hydration and UI work.

The fixed parent period was **26 April 2026 22:00 UTC through 26 October 2026
22:00 UTC**, with an exclusive upper bound. Intervals were calendar months in
UTC, with 7-/14-day controls and selected one-day prototype checks. Two logged
Exact terms are labelled **A (three characters)** and **B (seven characters)**;
actual terms, group keys, SQL, message IDs, frequency keys and plans stay private.
A generated token absent from the dataset supplied a no-match control.

The source query was reconstructed from the captured network candidate filters:
body, filename and current attachment text/member/summary matches, permitted and
selected groups, dates and deletion checks. It used the corrected joined inbox
ID for attachment membership. For message totals, the outer group join became
an equivalent membership EXISTS so messages were counted once; the unused post
join was removed. These are eligible-message diagnostics, not byte-for-byte
HTTP count/facet endpoint queries or reconstructed original POST payloads.

The body trigram index was valid. The installed schema still lacked
`signal_message_audio_search`, so every compared query consistently used the
installed body/media/chunk sources. PostgreSQL reported version 18.4, 8-GB
shared buffers, 8-MB work memory, JIT enabled and at most two parallel workers
per gather. Host-visible CPU affinity covered 56 CPUs; ordinary application
traffic continued. No cache flush, warm-state assertion or load isolation was
performed. The order of comparisons was varied.

Seven initial plain-EXPLAIN construction attempts exposed a missing outer group
alias while simplifying the captured query. They were corrected before actual
execution and excluded from performance results. Diagnostic PostgreSQL errors
and statement cancellations are not application HTTP failures.

## Window width alone did not bound the expensive count

For **A**, the indexed count reached the eight-second statement budget for
**7 days, 14 days, 1, 2, 3, 4 and 6 months**. The planned path still constructed
the global body/attachment match bitmap before applying the period. Making
the date predicate smaller did not establish a safe execution budget.

The first materialized candidate-before-body count prototype also reached the
budget for one day through four months. Separate JIT-disabled checks still
reached it for one day, seven days and one month. That candidate-first count
prototype is not a demonstrated fix; the fast Fuzzy prototype from iteration 12
does not establish its performance for this different Exact workload.

For **B**, two suffix sweeps with opposite run order produced:

| Period, same upper bound | First sweep | Reverse-order sweep |
| --- | ---: | ---: |
| 7 days | 6.758 s | 1.349 s |
| 1 month | 1.580 s | 1.128 s |
| 2 months | 1.905 s | 1.182 s |
| 3 months | 1.908 s | 1.424 s |
| 4 months | 1.984 s | 3.966 s |
| 6 months | 2.788 s | Cancelled at 8 s |

The large cache/run-order effect is visible in buffers: the first seven-day
probe read 113,806 shared blocks, whereas its reverse-order repeat read none.
Shared-block reads are not a measurement of physical disk I/O. These samples
do not prove that a month is intrinsically faster than a week, or that three
months will always beat four. The body-index candidate count remained the same
across these period widths; date filtering did not remove that repeated global
matching work.

## Complete six-month count, split several ways

Each completed partition covered the same parent range, newest window first.
All returned **19,225 messages** after summing non-overlapping window results.
The second pass changed the order of partition sizes rather than forcing cache
state. A four-month strategy means a four-month window plus a two-month remainder.

| Window cap | Statements | First pass total | Second pass total | Approximate buffer accesses versus unsplit |
| --- | ---: | ---: | ---: | ---: |
| 1 month | 6 | 9.439 s | 9.971 s | 2.80× |
| 2 months | 3 | 8.818 s | 3.886 s | 1.72× |
| 3 months | 2 | 2.668 s | 2.798 s | 1.36× |
| 4 months | 2 | 2.780 s | 9.112 s | 1.36× |
| Unsplit six months | 1 | 3.407 s | 2.324 s | 1.00× |

An additional unsplit baseline before the first partition pass was cancelled
at eight seconds. The successful first-pass unsplit value was collected after
the partitions. Consequently this table is not a controlled speedup claim for
three-month chunks: their near-zero shared reads cannot be compared causally
with the reads in another run. Across all completed unsplit samples, execution
was 2.324–3.407 seconds; two other unsplit count samples reached the budget.

Logical buffer accesses were much more stable than elapsed time: approximately
436,000 for unsplit, 592,000 for three-/four-month caps, 747,000 for two-month caps
and 1.22 million for one-month caps. Smaller statements repeated work. For B,
larger windows were feasible and sometimes cheaper overall; neither two months
nor a three-month activation threshold is established as a general optimum.

## Distinct-count merging was verified

The full parent period had **1,960 distinct normalized frequency keys**. Actual
key-set unions matched the full-period key set for two-, three- and four-month
partitions, while simply adding window distinct counts would give:

| Cap | Sum of window distinct counts | Correct union count |
| --- | ---: | ---: |
| 2 months | 2,631 | 1,960 |
| 3 months | 2,352 | 1,960 |
| 4 months | 2,294 | 1,960 |

This verifies why distinct endpoints need identity merging. It does not require
a shared historical snapshot: these checks used independent transactions, as
accepted by the user. Authorization and revision predicates were retained.

## Pages: access plan mattered more than calendar span

An ordered-date prototype used the existing
`sigint_inbox_item_datetime_id_idx`, correlated message/access checks and the
same body/attachment predicates, stopping after 20 matching IDs. It is a query
prototype, not a deployed implementation and not merely a different width:

| Period | A ordered page | B ordered page |
| --- | ---: | ---: |
| 7 days | 303 ms | 286 ms |
| 1 month | 264 ms | 163 ms |
| 2 months | 253 ms | 171 ms |
| 3 months | 256 ms | 163 ms |
| 4 months | 254 ms | 162 ms |
| 6 months | 260 ms | 173 ms |

The six-month plans visited 16,913 / 22,088 inbox rows respectively before
finding 20 matches. They did not enumerate the complete six-month match set.
The indexed-match-set page for B took 1.845–5.024 seconds across the suffix
sweep; A's seven-day and six-month indexed page probes were cancelled at eight
seconds. These comparisons include natural cache effects and must not be read
as isolated production endpoint speedups.

Actual first-page and later-page IDs/order matched bounded indexed reference
queries for both terms, with no page overlap. The reference lower bound was
the oldest returned timestamp: older excluded rows cannot outrank that page,
while every possible better row and timestamp tie remains in the comparison.
One-/two-/three-/four-month first windows returned the same parent first page.
Additional two-window checks returned the same 20 IDs after an empty first
window (0+20) or a partial first window (9+11), without duplicates.

The no-match control demonstrates why the ordered plan cannot be forced for
every search. The indexed six-month page finished in **20 ms**, and its count
in **46 ms**. The ordered scan took **704 ms for one day**, while its seven-day
page was cancelled at eight seconds. A bounded recent probe followed by an
appropriate selective-index fallback deserves separate validation; a universal
date-first scan or a universal monthly split is unsupported.

## Decision after measurement

Keep the accepted independent-window consistency policy, exact distinct-key
merging and stop-on-full-page behavior. **Do not select a blanket two-month
span or three-month threshold from these results.**

For B, three-/four-month count caps are plausible workload-specific options,
but smaller windows demonstrably increase total logical work. A requires more
than a calendar-width adjustment. For dense pages, ordered seeking is promising;
for absent/selective terms, the existing text-index plan remains important.
Selectivity, query shape, per-statement work and whole-operation cost must inform
the implementation instead of period length alone.

Coverage is limited to two Exact patterns and one synthetic no-match control,
descending interception-time ID pages and reconstructed filters. Fuzzy and
Substring modes, other sort bases, complete facet-specific own-filter semantics,
hydration, concurrent HTTP traffic and post-deployment latency remain unmeasured
in this round. The eight-second diagnostic limit is not the installed
application's fifty-second SQL timeout. No timeout defaults or application code
were changed, and no production deployment was performed.
