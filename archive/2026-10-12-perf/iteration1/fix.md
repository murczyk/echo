# Fix plan: echo-pivnich and echo-skhid

## Outcome and scope

The first batch is now applied to the current `3780-aor-perf` checkout.
It covers AOR candidate membership/count-only work and duplicate-link
indexing/projection. It was prepared and benchmarked against stable in a
separate worktree, then transferred here while preserving this branch's
existing changes. [Implementation evidence](implementation.md) records the
measurements and validation; [release instructions](../../../docs/performance/3780-aor-reconciliation.md)
cover migration, canary, and recovery. Other batches below remain proposed;
production has not been changed.

Remove the query patterns behind the observed timeouts and memory failures, while keeping authorized message sets, exact facet counts, search behavior, and Duty freshness/order intact. Use [perf.md](perf.md) as the evidence baseline.

This document proposes work; none of these changes has been applied to production. Numerical budgets below are benchmark/canary starting points, not validated production defaults.

Performance fixes should start from current stable in a separate development branch, rather than the inspected main checkout. Refresh the base and compare it with deployed 142f307e8d1 before implementing. Use a ticket branch or the repository's author/date naming convention. Keep changes independently reviewable and deployable:

| Priority | Work | Evidence / expected benefit |
| --- | --- | --- |
| P0 | Preserve logs and measure workload; enforce bounded heavy-query admission/cancellation | Avoid losing incident history and stop heavy facets from disrupting common reads |
| P1 | Scope PostgreSQL text matching before repeated aggregation | At least 704 Pivnich timeouts involve text search |
| P1 | Reshape analytics AOR joins and distinct work | One shape approaches the entire 17.60 GiB server budget |
| P1 | Index duplicate-group reconciliation after benchmark | Large sequential scans on both; approximately 85 GiB shared reads on Skhid in 208 seconds |
| P2 | Bound/optimize network last-seen recalculation | 23.2 s Pivnich mean; approximately 96-minute queue age |
| P2 | Reuse OCR queue positions and reduce repeated bounds/unit scans | Repeated global ranking, min/max, and high-read analytics shapes |
| P3 | Fix oversized redirect response headers; inspect maintenance and settlement lookup | Separate proxy failures and secondary measurable work |

Do not combine all work into one deployment. A small index fix or proven query rewrite can ship while larger search/AOR work is still being benchmarked.

## 1. Establish a reproducible baseline

Before changing anything, capture a fresh 10–15 minute window on each deployment and verify the installed ClickHouse version and analytics bundle. Retained history is incomplete and the morning sample is not the entire incident.

Collect:

- Endpoint status, elapsed time, operation, request correlation ID, query route, fallback reason, queue wait, and normalized query fingerprint. Avoid raw query strings, authorization headers, cookies, redirect URLs, and search content in access logs.
- PostgreSQL statement/lock timeout and deadlock counts, full-key pg_stat_statements deltas, temp work, blocking sessions, active worker counts, and reset/deallocation metadata.
- ClickHouse finished/exception query logs by fingerprint and user, read rows/bytes, peak memory, execution time, active concurrency, merges, disk/temp usage, and effective gateway settings.
- Queue age/count and per-batch duration for network recalculation; OCR ranking calls and cache outcomes; scope-cache hit/miss/in-flight sharing and key-cardinality metrics.
- Container CPU/I/O/memory PSI, service restarts, analytics heartbeat age, source-slot lag, and disk headroom.

Preserve at least a day's useful application incident history locally or verify equivalent central ingestion. Size retention from observed log throughput and a bounded disk allocation; do not choose an arbitrary journal size that still retains only minutes. Confirm restart/boot persistence and central freshness. Aggregate metrics can run continuously; detailed logs need bounded retention.

Use userid, dbid, queryid, and toplevel as the PostgreSQL identity. Record both snapshot endpoints. Detect resets, eviction, and newly appearing rows; do not compare queryid-only dictionaries.

Create protected benchmark databases from representative restored production-scale data for both deployments. Development fixtures alone cannot represent 18–30 million search rows or 32–39 million group links. Include broad and selective terms, short/recent and historical ranges, small/large group sets, realistic attachment distributions, unit filters, duplicate links, and undeleted/deleted messages.

Plain EXPLAIN first; then read-only EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON) with a defensive timeout on the benchmark database. Worker UPDATE statements must be analyzed through their SELECT equivalents, with mutation correctness tested separately. Retain old/new plans and metrics with the implementation PR.

## 2. Bound heavy workload without making fallback worse

Owning code:

- [analysis/mod.rs](../../../wdintel-rs/src/rer_importer/analysis/mod.rs): with_analytics_read_fallback_inner, analytics_fallback_needs_capacity, count fallback and retry state.
- [inbox/query.rs](../../../wdintel-rs/src/rer_importer/inbox/query.rs): candidate execution and revalidation.
- [config.rs](../../../wdintel-rs/src/config.rs): analytics pool/fallback/timeouts.
- [ClickHouse deployment](../../../deploy/clickhouse/README.md) and configuration scripts.

Existing controls must be extended rather than duplicated: analytics pool default 16, PostgreSQL failure-fallback semaphore 8 per process with 250 ms wait, operation retry/circuit behavior, and per-count queues. query_policy searches bypass failure-fallback admission.

### Application admission and cancellation

1. Add an explicit heavy-operation budget for search/facets and AOR work, separate from latency-sensitive Duty candidates/counts. Determine whether per-process limits are sufficient or need a deployment-wide gate when web/report/background processes share a database.
2. Bound waiting as well as executing work. Return the existing explicit overload/error response when capacity is exhausted; do not queue indefinitely or silently truncate results.
3. Cover direct query_policy searches as well as analytics failures. Avoid forcing ordinary supported Duty requests through the same small heavy-search gate.
4. Audit analytics-error fallback end to end. A memory rejection followed by another expensive PostgreSQL execution can move overload between databases. Preserve authorized/fresh fallback behavior, but admit it only within a measured capacity budget.
5. Verify cancellation through application task, PostgreSQL gateway, FDW/bridge, and ClickHouse query. An application timeout must not leave the original expensive query running while its fallback starts. First inspect the gateway path and query-log completion after cancellation; do not assume transport cancellation reaches ClickHouse.
6. Prevent duplicate requests for identical in-flight work where safe. Include the complete authorization/filter/time-basis/facet identity, bound keys, release failures, and preserve cancellation semantics.
7. Audit frontend retries/polling during overload. Respect Retry-After and cancel obsolete filter requests; add jitter/backoff if existing clients repeatedly regenerate the same expensive facets.

### ClickHouse profile and query budgets

Both gateways default to auto(32) threads, unlimited per-query/per-user memory, unlimited user concurrency, and no default execution limit. Server-level memory rejection is therefore the last observed protection.

Benchmark a gateway profile and heavy-query overrides using existing supported settings: max_threads, max_memory_usage, max_memory_usage_for_user, max_concurrent_queries_for_user, and max_execution_time. Inspect the installed version and per-query overrides before selecting values. Apply memory/concurrency restrictions to the gateway workload without inadvertently limiting CDC or administrative maintenance.

An initial benchmark matrix could test 4/8 query threads and 2/4 heavy requests, then choose a per-query allowance from the rewritten query's measured peak. For example, a rewritten AOR query below 2 GiB with four heavy requests has a very different budget from the current 15.46 GiB query. Reserve measured headroom for common queries, merges, ingestion, and runtime allocations inside the existing 17.60 GiB limit. Do not treat a concurrency count multiplied by one peak as a complete server RSS prediction.

A cap alone will reject the current AOR query sooner; it is containment, not a successful-query fix. Deploy tight caps only with a tested query path, acceptable explicit error behavior, and a bounded fallback. Raising the total-server memory ratio or increasing pools/timeouts would postpone failures without removing work and is not the first remediation.

Benchmark supported spilling join/aggregation options if a scoped rewrite still exceeds its budget. ClickHouse documents disk-backed join choices and their memory/latency tradeoffs; select against the installed version and measured temporary-disk demand, especially on Skhid's 74%-used analytics disk. A GROUP BY spill threshold does not independently fix hash-join memory. [ClickHouse join guidance](https://github.com/ClickHouse/clickhouse-docs/blob/main/docs/guides/joining-tables.md).

Persist reviewed settings through the owning deployment scripts/configuration, with idempotent reconciliation and a check mode. reconcile-gateway-settings.sh currently configures the PostgreSQL gateway's merge-join behavior; it is not already a ClickHouse resource-profile reconciler.

## 3. Rewrite scoped PostgreSQL search

Owning code: [attachments/search.rs](../../../wdintel-rs/src/attachments/search.rs), [analysis/search.rs](../../../wdintel-rs/src/rer_importer/analysis/search.rs), [analysis/stats.rs](../../../wdintel-rs/src/rer_importer/analysis/stats.rs), and [inbox/query.rs](../../../wdintel-rs/src/rer_importer/inbox/query.rs). Inspect their callers before changing the shared predicate API.

The captured plan deduplicates approximately 777,612 global search matches before intersecting the time/group candidates. Existing GIN/trigram/time/group indexes are present. Optimize candidate scope and reuse first.

### Query alternatives to benchmark

- Build a narrow authorized candidate relation using deletion, time basis, date/cursor bounds, groups, and applicable common filters. Apply body/media/current-chunk matching against that relation before deduplication or facet aggregation.
- For narrow candidate sets, compare indexed body-by-ID and media-by-message-ID EXISTS probes with scoped UNION branches.
- For broad scopes and selective terms, compare GIN-first matches explicitly intersected with the candidate relation. Avoid a universal per-row correlated probe that regresses broad searches.
- Use semijoins/EXISTS when only membership is needed. Global UNION deduplication may be avoidable, but branch/term boolean semantics must remain equivalent.
- Reuse a request's matching IDs across compatible computations, or singleflight identical endpoint work. Independently requested facets may remove their own selected filter, so one final-result ID set cannot blindly serve every facet.
- Project IDs/filter fields rather than bodies or complete entities. Benchmark the cost of any MATERIALIZED CTE; materialization is not itself proof of improvement.

Do not introduce a hidden maximum date range, silently drop old matches, switch to approximate counts, or route search to analytics before replicated search semantics and freshness are proven.

Start without a migration. If scoped attachment probes need another access path, compare against existing signal_message_media(signal_message_id) and attachment_chunk(media_id,revision,ordinal) first. Add an index only when actual plans identify the missing access path and read savings justify write/storage cost. No duplicate GIN index is proposed.

Regression cases must exercise real database results for positive/negative/OR combinations across body and attachments, old/current document revisions, literal filename/numeric input, deleted and unauthorized messages, event versus creation time, and own-facet-filter removal. Preserve exact date inclusivity and deterministic keyset pagination.

## 4. Reduce AOR facet memory and fan-out

Owning code: build_aors_analytics_query_with_scope, build_aor_messages_query, and count_aors_raw_with_db in [analysis/stats.rs](../../../wdintel-rs/src/rer_importer/analysis/stats.rs); [derived schema reconciliation](../../../deploy/clickhouse/bin/reconcile-derived-schema.sh).

1. Produce the smallest authorized message-ID relation first. Use membership semijoins instead of multiplying message rows by every matching group where results allow it.
2. Join that relation separately to group-AOR and network-AOR branches. Push compatible message bounds and candidate membership into each branch before large join builds.
3. Carry only message_id and aor_id through link processing; deduplicate message/AOR pairs at a measured point. UNION ALL can remain useful if later exact deduplication is cheaper. Preserve overlaps between multiple groups, multiple networks, and both sources.
4. Remove the unconditional post join when no post-related filter requires it, after auditing filter dependencies. The captured unfiltered shape joins posts even though only IDs/counts are selected.
5. Examine reused group-source reads and broad derived-view join sides in the captured plan. Measure row counts before/after each branch and hash-build memory; do not attribute the entire peak to a guessed join.
6. Compare a SQL rewrite expressible through the existing gateway with a dedicated analytics query path if FDW translation prevents predictable scoping. Keep scope/freshness, permission validation, deletion/current-row semantics, and fallback at the established boundary.
7. count_aors_raw_with_db currently computes per-AOR distinct message counts, loads all rows, and returns their number. Benchmark a distinct-AOR existence/count query that avoids computing unused per-AOR message counts for the count-only endpoint. Verify it uses the same own-facet-filter removal and selected filters.
8. Consider a maintained derived message/AOR relation only if the scoped query is still too expensive. Define updates/deletes for group and network links, AOR hierarchy/deletion, reassignment, CDC ordering, rebuilds, and drift checks before adding persisted state.

Do not remove FINAL/current-row handling or deleted predicates to reduce memory. Do not replace exact distinct counts with ANY joins unless membership multiplicity has been proven irrelevant. Recent scopes must remain lower-bound-only where required for late arrivals; keep timestamp filters authoritative.

Test exact results against the PostgreSQL path with group-only/network-only/overlapping memberships, multiple authorized groups, deleted AORs/networks/messages, top-level filters, own-facet-filter removal, unit/tag filters, and replication lag/late arrivals. Run AOR concurrently with realistic common Duty work, not only in isolation.

## 5. Index duplicate-link reconciliation

Owning function: delete_previous_duplicate_group_links in [messenger/reconcile.rs](../../../wdintel-rs/src/messenger/reconcile.rs).

A justified candidate is a btree on (datasource_group_id, created_at, sender), optionally including signal_message_id and id if a narrow projection/actual plan benefits. Compare column order and size with representative selectivity. Do not start with signal_message_id <> value: it is not the selective lookup.

The partial datasource index for group_master_key IS NULL cannot cover the general lookup. Both captured plain plans choose a parallel sequential scan of approximately 32/39 million live rows.

Benchmark nonnull and null sender cases, ordinary and ambiguous matches. If replacing full-entity loading with a narrow projection, retain the >1 match safeguard, subsequent deletion/requeue behavior, and existing transaction/locking guarantees.

Plan an online index build for these large tables and verify the migration runner's transaction behavior. PostgreSQL prohibits CREATE INDEX CONCURRENTLY inside a transaction block; failed builds can leave invalid indexes needing deliberate recovery. Use a supported deployment/migration procedure rather than putting incompatible SQL into a transaction-wrapped migration. [PostgreSQL 18 CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html).

Measure write cost, disk headroom, build progress, locking, and source replication lag. Keep this index change independently reversible; avoid an emergency table rewrite.

## 6. Optimize and bound network recalculation

Owning file: [network/recalculation.rs](../../../wdintel-rs/src/sigint/network/recalculation.rs); constants in [config.rs](../../../wdintel-rs/src/config.rs).

Existing batching, task coalescing, advisory locks, row locks, SKIP LOCKED, and run budget should remain. The 300-second statement allowance can greatly exceed the 50-second run budget.

Benchmark:

- A dated branch with ii.datetime IS NOT NULL and direct freq/datetime predicates, using the existing (freq,datetime) INCLUDE(id) partial index.
- Separate null-datetime branches preserving timestamp then created_at fallback. Add the necessary IS NULL conditions so branches are disjoint and COALESCE semantics remain exact.
- Frequency/date-first candidates intersected with the unique (network_id,inbox_id) relation, versus the current network-history-first join.
- Descending, bounded last-candidate lookup where existing index direction/selectivity makes it viable. Backdated data, deletion, and membership changes must still allow the maximum to decrease.
- Smaller/adaptive batches based on measured work; reduce individual statement budget and checkpoint/retry without dropping tasks. Keep sorted lock acquisition and task ownership protections.

Do not replace last_seen_dt with GREATEST(old,new) unconditionally: deletion/reassignment can invalidate the old maximum. If considering incremental maintenance, retain a reconciliation path and all existing invalidation producers.

Prove completion/retry/cancellation behavior and exact values for active ranges, deleted networks/frequencies/messages, null timestamps, duplicate task arrivals, concurrency, and reduced maxima. Record oldest task age and per-batch progress; lower concurrency without a cheaper query could make backlog worse.

## 7. Reuse expensive repeated calculations

### OCR ranking

Owning function: load_queue_positions in [ocr/mod.rs](../../../wdintel-rs/src/ocr/mod.rs).

Compare a bounded process-level singleflight snapshot of global internal ranks with a requested-media ranking strategy. Filtering media before row_number would change ranks and is incorrect; count all preceding eligible items or rank the whole relation before selecting requested IDs.

Choose a short, explicit freshness policy; invalidate after enqueue/reprocess/state transitions or document bounded eventual freshness. Time-dependent retry/discovery behavior must expire naturally even without writes. Include database identity in cache keys, bound memory, avoid retaining failures, and handle multiple processes.

Media authorization remains per request. Do not cache user responses or reveal inaccessible media through a shared queue cache. Preserve queue_positions_count_only_items_ahead and the state/deletion/ordering behavior in database-backed tests.

Inspect actual plans for each UNION branch and sort before proposing indexes. ocr_job_due_idx and media(created_at,id) already exist.

### ID bounds and analytics unit counts

Inbox/analysis bounds already have 5-second caches and singleflight. Instrument them first, then reuse compatible scopes across a request and callers. Respect separate databases/pools, sort basis, inclusive/exclusive endpoints, freshness, source-versus-analytics bounds, failures, and recent-window behavior.

Do not round timestamps as a cache trick unless the resulting ID scope is conservative and original timestamp predicates still enforce exact membership. Do not replace MIN/MAX(id) with the first/last timestamp row: IDs and event time can disagree. Keep the existing OFFSET 0 safeguard unless representative actual plans prove a safe replacement.

For unit-count shapes, inspect [analysis/analytics_unit.rs](../../../wdintel-rs/src/rer_importer/analysis/analytics_unit.rs) and stats query builders. Benchmark time/ID predicates pushed into membership branches and reuse existing resolved-unit filter caching. Compare rows read, not just elapsed time. Preserve exact/expanded unit semantics and permission checks.

Request-local permission reuse is lower risk than new shared authorization caches. Any shared cache must be keyed/versioned for the correct user, group membership, and permission changes.

## 8. Redirects and secondary database work

### Oversized response headers

Inspect [nginx templates](../../../deploy/nginx/echo-pivnich) and the logout/delta redirect producers. Reproduce a large saved filter/state without recording sensitive URLs.

Prefer a short opaque state identifier backed by an expiring server-side record, or a bounded safe return path. Preserve return navigation, authentication-state validation, one-time/expiry rules, and redirect-target validation. A bounded proxy response-header buffer can be an interim adjustment after measuring headers and validating nginx configuration. Large client-header settings do not solve this response path.

Verify large-state login/logout/redirect responses and their actual HTTP statuses separately from search 503s. Check the AI-stream close events only if reproducible; there is insufficient evidence to call them a database failure.

### Maintenance and settlement query

Inspect Skhid's search analyze cadence, message-table dead tuples, vacuum progress, relation settings, old transactions/replication horizons, and actual visibility/plan estimates. Choose targeted maintenance only if justified. Raising work_mem globally, VACUUM FULL, and broad reindexing are not supported first fixes.

Trace settlement query -3520703590422063962 to its actual caller/dependency. Compare batching/request-local reuse and index-compatible spatial candidates followed by exact distance ordering. The existing GiST expression and null-coordinate predicate must match. Do not assume a nearest-neighbor operator has identical distance/tie semantics or edit settlement/resolution.rs simply because its name looks relevant.

## 9. Validation gates

Proposed targets must be finalized against representative workload expectations before deployment:

| Work | Required evidence / proposed acceptance target |
| --- | --- |
| Search | Exact results preserved; former failing representative requests complete; at least 50% lower elapsed time and shared reads for expensive baseline shapes, with a proposed interactive p95 under 3 s |
| AOR | Exact counts preserved; measured peak below a chosen per-query budget (initial benchmark goal under 2 GiB); no total-memory failures or common-Duty starvation under representative concurrency |
| Count-only AOR | Same AOR cardinality without unnecessary per-AOR message counts; lower rows/memory/time |
| Duplicate links | Selective index access for equality predicates; sharply reduced reads; null/ambiguous safeguards preserved |
| Network | Bounded per-batch execution and cancellation; exact recalculated values; oldest queue age falls under sustained ingestion |
| OCR | Large reduction in repeated full-rank executions; correct queue order and bounded freshness; no unauthorized response leakage |
| Bounds/unit work | Better cache-sharing/read counts under real parameter variation; no late-message omission |
| End-to-end | No timeout-derived 503s for the agreed baseline workload; overload explicitly bounded; Duty latency/freshness and replication remain within baseline limits |
| Observability/redirects | Measured retained history/status metrics and successful large-state redirects |

Targets are goals, not results of this investigation. Broad worst-case queries may need explicit product-approved limits rather than a promise that every input completes under 3 seconds.

For Rust implementation, run cargo check, cargo clippy, and appropriate focused database-backed regressions. Keep formatting narrow and cargo fmt clean. For frontend changes, run staged Prettier for affected JS/TS/CSS/JSON and just build-front; retain the #3546 CI regressions described in the [Duty creation-time contract](../../../docs/duty/README.md#creation-time-contract). Duty always uses creation time; Analysis's preference must not change Duty. Respect existing Ukrainian API-error toasts.

Do not add tests that merely mirror generated SQL or formatter layout. Result/authorization/time/cancellation regressions and production-scale plan comparisons protect the actual failure modes.

## 10. Schema, deployment, and recovery

For each required schema change:

1. Review comparable migrations. Add a new datetime-named pure-SQL migration under echo-migration/src and register it in lib.rs; never edit deployed migrations.
2. Review the coupled deploy/clickhouse/migration-impact.json declaration, even for index-only changes. Do not invent a data backfill when the catalog impact does not require one.
3. Evaluate write/lock/storage/replication costs; decide the supported concurrent-index workflow before release. Any new derived table needs CDC exclusion/replication, rebuild, deletion, and recovery design.
4. Apply locally with just migrate-up and check down/recovery behavior. Run just gen-seaorm if table schema/model definitions changed.
5. Restore the standard test dump into a dedicated database and run the catalog-aware check with the full stable base:

~~~bash
source deploy/setup_test_database.sh <branch-safe-name>
GITHUB_BASE_REF=stable TEST_DB_NAME="$DB_NAME" scripts/ci/check_analytics_migration_catalog.sh
~~~

An empty test database or the Python checker alone is insufficient. Keep standard migration recovery consistent; do not manually delete migration records during routine rollout.

Rollout sequence:

1. Review baseline/benchmark evidence and changes independently. Verify the installed binary/config versions and capture previous configuration for rollback.
2. Deploy one proven change at a time. Begin with a low-traffic canary on the affected Pivnich path after restored-data validation; do not load-test the incident host to prove safety.
3. Observe at least 30–60 minutes of representative activity, including background ingestion and facet requests. Require a later peak/broad-window observation before calling the incident resolved.
4. Compare query fingerprints and completed/error counts, route/fallback distribution, p95, queue waits, tracked memory/RSS/PSI, task ages, and replication freshness. Compare matched windows/parameters rather than raw totals from dissimilar traffic.
5. Apply to Skhid only after the same workload/correctness gates pass; it has larger search/group tables and a different morning workload.
6. Roll back the binary/query path or resource configuration if results differ, timeouts rise, queues grow, or common reads regress. A harmless added index can remain while its application change is reverted; avoid costly emergency drops/rebuilds.

Record final settings, old/new plans, production measurements, and recovery steps in the owning component's focused documentation and PR. Leave overview README files unchanged unless their architecture/setup description becomes inaccurate. Add the appropriate issue-linked changelog entry when implementing fixes, not for this investigation archive.

## Open decisions before implementation

- Which real search/facet parameters represent the user's failing workflows, and what exact wide-range product behavior must remain?
- How much memory belongs to AOR hash builds versus duplicated join rows/distinct aggregation, and can the gateway express the desired scoped shape?
- Does cancellation terminate the ClickHouse work before PostgreSQL fallback?
- How many application processes share each gateway and budget, and which settings are overridden per query?
- Why do existing bounds caches still generate the observed min/max volume?
- Which supported migration/deployment procedure can build the large reconciliation index concurrently?
- Where is the measured settlement query generated?

These questions guide measurements and implementation choices; they do not invalidate the confirmed timeout and total-memory failures.
