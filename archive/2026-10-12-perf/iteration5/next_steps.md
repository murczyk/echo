# Remaining investigations (#3780)

These changes are deferred pending evidence. Baseline observations and the
approved fixes are in [findings.md](findings.md) and [plan.md](plan.md).
Do not increase pools, fallback slots, timeouts or shared memory ceilings as a
substitute for cheaper work. Production inspection remains read-only.

## Network recalculation and bounds (original item 5)

Pivnich's largest last-seen batch averaged 21.25 seconds and 4.36 GiB of shared
block reads; 287 pending tasks had a 53.6-minute oldest age. Skhid's sample was
5.90 seconds with three recent queued tasks. This warrants investigation but
does not establish that smaller batches will drain faster.

A read-only follow-up at **19:18:55 UTC** found 240 last-seen tasks on
Pivnich, oldest 47.6 minutes, and no recalculation tasks on Skhid/Siversk.
Pivnich's oldest task moved forward from 14:43 to about 18:31, demonstrating
progress with a continuing backlog. These snapshots do not measure arrival or
completion rates. The code allows a 300-second statement inside a 50-second
run budget; inspect actual statement durations before changing that mismatch.

1. Capture queue arrival/completion rates, oldest age, batch sizes, blockers and
   statement plans across matched peak/quiet windows on all three hosts.
2. Compare date/frequency-first candidates using the existing index with the
   current message-ID-first plan. Keep disjoint nonnull inbox-date, timestamp
   and creation-time branches. Test nullable dates, reassignment/deletion that
   decreases maxima, active ranges, duplicate tasks and concurrent writers.
3. Compare total work per completed task before changing batch size, scheduling
   or per-statement/run budgets. Require falling queue age under normal ingest.
4. Pivnich network-ID bounds averaged 2.60 seconds and 1.29 GiB reads. Compare
   endpoint seeks on `(network_id,inbox_id)` for sparse, absent, new and common
   networks, small/large arrays and generic prepared plans. The common-network
   rewrite already tested slightly slower; it is not a proven fix.
5. Siversk creation-time bounds consumed 37.8 execution seconds/7.35 GiB reads
   in the 115-second sample (127 calls). Measure cache misses, key churn, date
   selectivity, heap visibility and generic/custom plans before changing its
   five-second TTL or adding an index. Preserve safe late-arrival bounds.

## Operational failures and warnings (original item 6)

GOI row dumps, short retained journals, deployment connection failures, expired
OCR grants and settlement/battle-line locks have separate failure mechanisms.
The approved patch does not change these flows.

At approximately **19:20 UTC**, retained application events began at 19:04
on Pivnich, 12:23 on Skhid and 13 October 06:11 on Siversk. Total journal disk
usage was 112.5 MiB, 1.5 GiB and 1.6 GiB respectively. Pivnich had no
`/var/log/journal` directory; the other two did. Verify effective journald
storage and central delivery before choosing retention settings. See
[follow-up measurements](followup_measurements.json). GOI source inspection
confirms separate INFO dumps for every candidate and selected row, in addition
to summary messages; consumers and byte rates still need checking.

1. Check central log freshness and actual local bytes/hour across a restart.
   Determine disk budget and incident retention before increasing it. Preserve
   HTTP/request/SQL correlation. Compare GOI per-row log volume with sync totals
   and consumers before replacing logs with summaries or opt-in details.
2. Reproduce deployment phases and failure cleanup in an isolated installation.
   Measure the interval between API shutdown and readiness. Check whether
   package staging or a proxy maintenance response reduces observed failures
   while preserving migrations, existing maintenance protocol and older clients.
   Prepare recovery for download, migration, service-start and health failures.
3. Trace oversized upstream redirect headers at their generating endpoint.
   Request-header buffers cannot resolve response-header growth; capture the
   redirect chain and response sizes before selecting a change.
4. Reproduce OCR grant expiry in long-open tabs and across session/deployment
   changes. Establish refresh/retry authorization semantics before altering it.
5. Capture blockers, transaction duration and lock order for settlement updates
   and battle-line advisory locks. Identify conflicting writers before adjusting
   transaction scope or scheduling; do not simply hide warnings/raise timeouts.
6. Attribute repeated empty-tsquery notices to actual callers and arguments.
   Benchmark parsing reuse only where repeated work is material, preserving
   filename/numeric, empty-lexeme and negative-search behavior.

## Analytics resource profile

The AOR rewrite has a measured small-memory plan, but supported successful
queries still reached 6.89 GiB and the server ceiling is 17.60 GiB. Automatic
32-thread sessions currently have no query/user memory, concurrency or native
execution limits. One successful bounded diagnostic is insufficient to set a
universal 2-GiB cap.

Replay representative ordinary Duty plus two/four heavy AOR/unit/tag workloads
on a restored representative dataset. Measure useful throughput, p95/p99,
tracked memory/RSS, cancellation latency and CDC/maintenance headroom. Then
prepare a persistent gateway-only thread/deadline/memory/concurrency profile,
its reconciliation check and a rollback. Include disk headroom before enabling
spill. No new production profile was applied during this work.

## Wider source search and cancellation

The direct quoted-body predicate reduces redundant work, but both old/new
8/16/31-day samples exceeded the five-second diagnostic limit. The global
AllTags aggregate was slower for a short source request and forced gateway
aggregation local. Retain the correlated row-count semantics and measured
constant-access pushdown. Test candidate/time/group-scoped source relations,
GIN-first intersections and later pages on restored production-scale data
before another rewrite. Preserve OR alternatives and duplicate association
counts; do not introduce new count sharing.

Verify end-to-end cancellation separately at SQLx, source PostgreSQL, gateway
and ClickHouse. The 60-second HTTP deadline drops the handler and its queued
waiters, but does not prove that submitted remote SQL is immediately cancelled.
Do not begin a second fallback after an expired request.
The deadline also surrounds session/activity middleware waits. Its explicit
`analytics_route` timeout log remains available when cancellation interrupts
activity export before a response event is stored. Correlate the retained
30/50-second frequency/callsign HTTP 500 error chains before changing their
separate database-timeout mapping.

## Recurring Duty and OCR work (original item 7)

Attribute Duty count requests by frontend release, tab, visibility and trigger
before changing polling. Preserve discovery, unread state, notifications and
creation-time ordering. The earlier Analysis polling fix is already deployed.
Skhid OCR queue ranking averaged 586 ms (33 calls in the sampled interval).
Measure repeated snapshots and invalidation needs before sharing/reusing a
rank computation; filtering before global ranking changes its meaning.
