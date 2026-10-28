# Production verification for search performance (#3780)

Use this checklist after each independently approved deployment, after
30–60 minutes of normal load, during a later peak period and again the next
day. The [25 October Skhid observations](../../archive/2026-10-12-perf/iteration8/findings.md)
and [Pivnich follow-up](../../archive/2026-10-12-perf/iteration9/findings.md)
are references, not acceptance thresholds or proof of peak capacity.
Keep exact filters and raw message/request identifiers private.

## Read-only inspection

Record the package version, API/worker start times, restart counters and exact
UTC windows. Use [monitoring access](../MONITORING.md) or local journals for
`wdintel-rs` and `wdintel-rs-bgworker`. Include every hostname used for the
installation when reading `activity_details`; on Skhid these include the public
hostname, Tailscale hostname and direct-IP API hostname.

1. Compare equal 10–15-minute windows with comparable traffic and filter mix.
   Select response events and deduplicate by request ID. For inbox pages,
   inbox counts and each relevant facet, record request count, successful
   completions, 5xx/503 counts, p50/p95/maximum and requests above two seconds.
   Exclude intentional event-stream long polls from interactive latency.
   Cross-check deadline logs against retained request/response pairs: releases
   before the deadline-recorder repair can omit a 503 completion entirely.
   Count those separately instead of claiming zero failures from response-only
   telemetry. Updated releases should retain one actual-status completion per
   request, including a 60-second deadline.
   Investigate tails even when p95 and error counts improve; lower traffic or
   faster rejection is not evidence of recovery.
2. Aggregate `analytics_route` by operation, route, outcome and reason. Compare
   useful analytics completions, PostgreSQL completions, queue rejections and
   timeouts. Distinguish query/user resource limits from total-server memory
   exhaustion and shared-circuit fallback. For attachment fallback, correlate
   `attachment_search_coverage` reasons: tracking, retention, historical
   coverage, pending-ID overflow and relevant recent changes have different
   causes. Complete history does not make a recent-change fallback incorrect.
   Correlate request IDs across count-queue, source-admission, source-pool and
   SQL stages; distinguish ordinary ten-second admission/pool rejection, historical count
   operation/queue waits, SQL execution and whole-request expiry. During comparable multi-user traffic, verify useful
   completions for another user while one user loads several facets. Check
   active source backends after expiry and `cancel_sent` failures; a completed
   HTTP response does not prove database cancellation. Verify source pools keep
   their normal JIT setting after bounded complex searches.
3. On the paired analytics host, read existing `echo_analytics_health` and
   `echo_analytics_attachment_search` rows, and source slot activity/LSN lag.
   Check freshness repeatedly rather than trusting one healthy sample. Run
   `reconcile-gateway-limits.sh --check` to inspect the existing limits; its
   no-argument form changes configuration. **Do not run
   `check-analytics-health.sh` as an inspection:** it writes a heartbeat and
   health metadata. Reconciliation, resnapshot, retry reset and recovery
   operations need separate approval naming their target.
4. Read native `system.query_log` for the exact window and gateway user,
   separating query starts, completions and exceptions. Record query count,
   normalized fingerprint, p95/max duration, peak tracked memory, read rows,
   result rows and error code. Exclude diagnostic requests from application
   error counts. Raw CDC-version reads, tracked query memory, process RSS and
   physical disk I/O are distinct measurements. The packaged
   `query-performance-report.sh MINUTES LIMIT` provides a read-only starting
   point; its gateway statement statistics are cumulative since their reset.
5. Compare source `pg_stat_statements` deltas with unchanged reset/deallocation
   counters, active waits, replication lag and ingestion latency. Check that
   lower ClickHouse errors have not shifted the cost into PostgreSQL. Never
   reset statistics for a comparison. Bound diagnostic SQL with read-only
   transactions, statement/lock timeouts and modest native memory/thread caps;
   inspect plain plans before executing actual plans.

## Historical-window verification

Use the search SQL/HTTP settings documented in [search routing](3780-search.md#execution-budgets).
Verify the upstream proxy read timeout exceeds the configured search HTTP budget.
Check a search beyond the ordinary 60-second deadline and its eventual configured
expiry; a non-search request must still expire at 60 seconds. Verify React counts
and Duty search requests survive their former 35-/65-second limits and still
cancel on filter changes. An HTTP/client expiry must stop the pinned source SQL.

For counts, compare the complete period with exact sums and distinct-key unions
from disjoint windows. Include null/empty frequencies, canonical units and the
undefined-unit bucket, normalized callsigns, tags, groups with missing secret
groups, and each facet's own-filter removal. Exercise midnight and sub-millisecond
boundaries, exclusive Analysis and inclusive inbox upper bounds, empty windows,
current/stale attachments, deleted/inaccessible messages and a failure after
prior progress. A failure must never return a partial total.

Check the parent indexed probe, quarterly probes and daily date-first fallback
separately; report their combined request cost. Measure common short, selective
and no-match terms with warm/cold-cache variation. Confirm date predicates
constrain attachment membership and body primary-key work in daily queries.
Verify the indexed alternative remains available for empty pages. Compare first
and later pages, 0+20 and 9+11 merges, all three time bases and both directions.
Run concurrent counts and pages for the same and different users; counts must
release SQL capacity between windows and leave room for pages.

For network activity, inspect the final native aggregation separately from its
period-bounds stage. Every large input needs explicit ID bounds. Compare complete
results after range merging, including Kyiv day boundaries, multiple groups,
network/frequency validity, null interception/timestamp fallbacks and the latest
activity timestamp. Inspect source daily candidate/link plans for full-history
scans or temporary spills. Keep network reads on the ordinary 60-second deadline.
Measure total traversal and concurrent aggregate memory as well as per-range
cost. The local probes do not establish full HTTP latency or eliminate shared
native memory failures; those require a separately approved rollout.

## Representative workload and correctness

Compare source and analytics IDs, counts and ordering for 1-, 7-, 8-, 16- and
31-day scopes, later pages and ascending/descending timestamp and creation
ordering. Include broad and selective authorization, empty results, a single
group, many groups, unit names, direct unit IDs, denied unit IDs, the combined
header/network-unit OR direct-ID branch, frequencies, tags, networks, AORs and
metadata/daily-activity facets. Include filters just across the seven-day
strategy boundary and equal timestamps at page boundaries.

For Fuzzy search, cover positive/negative terms, prefixes, OR alternatives,
stop words, body, filename and attachment content. Confirm native predicate,
ordering and limit pushdown through the actual prepared gateway plan. Check
quoted Fuzzy, Exact and Substring results through their source route. Recent
open-ended ID scopes must retain messages arriving after range planning;
closed scopes must keep their upper bounds. Any failed range must fail the
whole analytics attempt rather than return partial totals.

For full-period source search, compare broad scopes with one selected nonempty
frequency over all five date ranges. Check pages, counts and group/sender/tag
facets, and confirm the frequency facet still ignores its own selected filter.
After migration `m20261025_180900_inbox_body_literal_index`, inspect
`pg_index.indisvalid`/`indisready` for `sigint_inbox_item_body_literal_idx` and
representative exact/substring plans. Include common/rare words, short patterns
without useful trigrams, quoted wildcards, empty/null bodies and current/stale
attachment revisions. During an approved index build, watch
`pg_stat_progress_create_index`, free disk, source write latency and replication
lag; concurrent creation still consumes CPU, I/O, WAL and permanent index space.
Confirm the migration's `ANALYZE` completed: fresh expression statistics are
needed to choose a scoped scan for common body terms. Inspect attachment-ID
subplan rows and backend memory under simultaneous broad filename/content
searches; the distinct attachment-ID array grows with matching media, even
though body matches are never collected into that array. Include creation-time
and unbounded latest reads of attachment-only messages without an inbox row.
Verify `SHOW plan_cache_mode` on web source/replica connections and exercise the
same prepared search statement repeatedly with rare/common terms and varied
dates. Web pools should use custom plans and retain statement/lock/idle-transaction
deadlines; worker/operator plan policy stays unchanged. Include planning time
and CPU in the comparison, since custom plans trade extra planning for better
parameter-specific execution.
An interrupted concurrent build can leave an invalid index with the same name.
Inspect its catalog state and migration history before retrying. Prepare any
`DROP INDEX CONCURRENTLY` and migration retry as a separate recovery operation
requiring approval for the named target; do not delete migration records or
drop a valid index as part of verification.
If index creation succeeded and only statistics refresh failed, the migration
can resume against a valid, ready index. Its validation rejects invalid builds.
Retries also verify the GIN expression, trigram operator class, collation and
absence of a partial predicate. A ready index with a different definition
requires separate operator reconciliation; the migration leaves it intact.

For unbounded latest pages, verify both dense recent traffic and a sparse/empty
two-day creation-time probe. Dense probes must match the full-history top 20;
sparse probes must still fill from older messages. Include equal creation times,
old interception times on newly imported messages, deleted/inaccessible rows and
unlimited reads. Compare total request cost, including source range planning and
the additional probe when it cannot fill a page. For fresh-tail text reads,
verify the candidate-ID correlation in every text source and measure the tail
count/page separately from the analytics part of the request.

Attachment changes require equivalence checks for insert, edit, rename, move,
deletion, negative matches and backdated imports inside and outside the allowed
groups/dates. Verify pending ledger rows and transactions longer than the
freshness window retain source fallback. Use existing captured changes for
read-only production inspection; create/edit/delete test messages only in an
isolated test environment or under separately approved production operations.
Do not clear coverage or freshness guards to obtain a faster result.

## Ingestion and completion criteria

Track queue depth, oldest age, throughput and retry attempts for active linked
sources, separating deleted/unlinked sources and historical recovery. Inspect
deadlocks, lock timeouts and idle-transaction terminations. Let previously stuck
snapshots take their normal scheduled retries; do not reset attempts. Verify
persisted active message/inbox state or an expected duplicate trace after a
snapshot leaves the queue. Queue disappearance alone does not prove ingestion.

For legacy media summaries, compare completed/retry/failed/superseded attempt
metrics and queue age. In an isolated test environment, publish a new attachment
document or requeue/delete a job while an older AI attempt is in flight. Its
result/error must leave the replacement untouched, emit a superseded outcome,
and avoid publishing an inbox update or enqueueing positions from obsolete
work. A current document must prevent new legacy claims. Investigate repeated
supersession and missing AOR assignments separately; neither justifies changing
access settings or resetting jobs during read-only verification.

Keep the issue open while representative broad scopes remain unmeasured,
source timeouts recur, interactive tails worsen, or replication/ingestion falls
behind. Result/access differences, repeated total-server memory errors,
sustained admission rejections or increased source failures stop rollout
expansion. Fixes are locally validated until the next approved deployment and
its follow-up windows confirm behavior; a successful unit test or a single
fast diagnostic query is insufficient production evidence.
