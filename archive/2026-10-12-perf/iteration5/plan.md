# Approved stabilization work (#3780)

Implementation is on `3780-stabilize-fixes`, based on `main` at
`2dada7b55`. The deployed comparison baseline is `stable` at `ad2678da257`.
Main's Exact/Substring search modes and newer migrations are retained.
Production access during this work is read-only. The original
investigation is in [findings.md](findings.md); deferred work is in
[next_steps.md](next_steps.md).

## 1. Bound the whole request

Add one 60-second deadline around Analysis statistics, callsign pages, Duty
inbox/count/matching reads and frequency listing. It includes handler waiting,
pool acquisition, analytics, fallback and response construction, below the
Analysis client's existing 65-second count deadline. Expiry returns the existing
503 API error format with `Retry-After: 1` and logs `reason=request_deadline`.
Dropping the handler removes its queued mutex/semaphore waiter. Existing database
statement timeouts still bound SQL that has already been submitted; this does
not prove immediate native ClickHouse cancellation or bound socket transmission.

No new count sharing, coalescing, cache or admission policy is included. Existing
coordination stays in place. Different users' counts are not assumed identical.

## 2. Remove selected-AOR join multiplication

Replace the two selected-AOR left joins with two separately scoped membership
subqueries joined by OR. Keep authorization on the outer candidate relation and
apply the same safe ID bounds inside each branch. This preserves group OR
network membership and prevents duplicate links from multiplying candidates.

The captured Pivnich failing count now plans as one foreign scan and its native
execution took 2,539 ms with 233,271,608 bytes tracked peak memory, under an
8-second/2-GiB/4-thread diagnostic limit. The recorded failing original peaked
at 11.37 GiB. These are different observations, not a controlled concurrent
before/after trial. Combining both branches into one UNION ALL membership set
left gateway aggregation local, so that version was discarded.

Resource profile enforcement still needs a representative concurrent workload;
see [next_steps.md](next_steps.md#cancellation-analytics-profile-and-broad-source-search). No guessed memory
or concurrency caps are activated by this patch.

## 3. Improve quoted search and tagged sender breakdowns

Use the already joined inbox body's JSON field for quoted Fuzzy search,
removing a redundant per-message lookup. Preserve attachment and negative
predicates. Keep unsupported quoted predicates on source until the gateway can
push down the complete operation. Keep the existing GIN/correlated strategy
boundary; a universal correlated rewrite is not included.

Resolve sender tag ownership/unit access once per tagged request on source,
then pass constants into the sender SQL. Remove unnecessary tag joins and
constant access-count subqueries when that access is already resolved. Keep
COUNT of association rows, confidence, model/unit restrictions, denied tags and
all-selected-tags access semantics. Source authorization remains authoritative.

The captured 8-day Skhid sender shape changes from local gateway aggregation to
one foreign scan. Its native execution took 1,524 ms with 847,765,981 bytes
tracked memory under the same diagnostic limits. Global grouped tag membership
regressed the short source query and prevented gateway aggregation pushdown;
it was discarded. A representative 1-day quoted query took 2,368 ms before and
1,358 ms after; both variants exceeded five seconds at 8/16/31 days. Cache order
was not controlled, so these timings establish limits rather than an SLA.

## 4. Scope attachment freshness without losing removals

Install source-only migration
`m20261015_184629_attachment_search_message_change`. It records changed message
IDs for searchable chunk/revision changes and media insert/rename/move/delete,
retaining both owners and deletion tombstones. Processing-only document updates
do not dirty searchable content. Mutations clear `changed_at`; the extract worker
timestamps at most 500 committed pending entries per minute. Their freshness
window starts at observation, so a long transaction cannot expire before commit.
Repeated mutations clear the timestamp again. A timestamp-leading index bounds
pending/recent reads; cleanup removes at most 500 observed entries older than
24 hours plus the request deadline per minute and never removes pending changes.
The additional interval protects in-flight requests at the retention boundary.

After one full freshness window of tracking, inspect at most 1,001 pending or recent IDs.
If more than 1,000 changed, retain full source fallback. Check request dates and
permitted groups against both source and analytics rows, independently of the
analytics ID optimization bounds: newly imported backdated messages and stale
former owners must remain detectable. Relevant changes use the source for the
whole operation. Unrelated activity can use analytics. Incomplete history,
unhealthy replication, the initial tracking window and freshness windows beyond
ledger retention force source fallback.
There is no cross-database count/result merge or reduced freshness interval.

## Rollout and recovery

1. Review and build the branch from `main`. Run the validations recorded in
   [validation.md](validation.md).
2. Canary Pivnich through the normal deployment workflow: sync the packaged
   analytics exclusions before source migrations, then update the backend.
   The ledger and singleton stay excluded; no attachment history resnapshot,
   PeerDB rebuild or manual `history_complete` update is required.
3. Wait the configured freshness window (currently 90 seconds). Check scoped
   search against source for edits, negative terms, renames, moves and deletions,
   including unrelated groups/dates. Confirm fresh analytics health.
4. Check affected Duty and Analysis workloads, including initial facet bundles,
   AOR-filtered pages/counts and tagged sender breakdowns. Compare useful
   completions, whole-request tail latency, source cancellations/reads, native
   memory, replication and ingest over matched 10–15-minute windows and a
   30–60-minute soak. Include peak load before broad rollout.
5. Repeat on Skhid, then Siversk; Siversk needs explicit overload checks even
   without source timeouts or native memory exceptions.
6. Revert the backend on result/access differences, increased source pressure,
   stale results, or ingest/replication regressions. Leave the ledger and its
   triggers installed when reverting only the backend; the old singleton guard
   remains maintained. Roll back the schema only after reverting the backend.

Deployment has not been performed. A faster overload response alone does not
establish that useful work improved.
