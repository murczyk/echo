# Performance incident: echo-pivnich and echo-skhid, 2026-10-12

## Conclusion

Production logs and database counters support the reported degradation. Two expensive query paths explain the strongest evidence:

1. PostgreSQL text search and associated facets repeatedly reach the runtime statement timeout. Application code maps SQLSTATE 57014 to HTTP 503. Pivnich recorded 877 statement timeouts since midnight; at least 704 explicitly involved text search.
2. ClickHouse analytics queries exhaust its shared 17.60 GiB server memory limit. An AOR facet shape accounts for 11 of Pivnich's 22 memory-limit exceptions in the sampled six hours, with a later individual-query peak of 15.46 GiB. Smaller concurrent queries are rejected during the same total-memory pressure.

Skhid has the same failure classes, with a concentrated timeout burst around 04:00 UTC and lower pressure during the morning inspection. Network recalculation, OCR queue ranking, ID-bound resolution, and duplicate-link reconciliation add measurable database work. Oversized nginx response headers are a separate redirect/logout failure.

This is a diagnosis, not a completed remediation. See [fix.md](fix.md) for implementation and rollout proposals. Production application configuration, services, schema, and data were not changed.

## Scope and evidence

All times are UTC on 2026-10-12 unless another date is shown. The main investigation ran approximately 07:15–07:33. Follow-up index, relation, and gateway-profile inspection ran approximately 07:40–07:47; its snapshots are distinguished below.

| Item | Value |
| --- | --- |
| Deployments | echo-pivnich, echo-skhid |
| Report | Numerous performance issues and 503 errors, particularly on Pivnich |
| Deployed version, both | 1.0.142f307e8d1 (10.Oct 16:50), commit 142f307e8d1 |
| Code inspected | Workspace main, HEAD 0bf3c627a; local origin/stable bffef890f |
| PostgreSQL | 18.4 on both |
| PostgreSQL log window | Midnight through approximately 07:30 |
| ClickHouse exception window | Approximately 01:27–07:27 |
| ClickHouse completed-query comparison | Approximately 07:12–07:27 |
| Matched PostgreSQL counter window | 07:24:21–07:27:49, approximately 208 seconds |
| Access | Existing unlocked SSH agent and deployment aliases; analytics reached through each deployment's existing machine access |

The important search, OCR, network-recalculation, inbox-query, and analysis-stats files were compared with deployed commit 142f307e8d1 and match it. The inspected analysis/mod.rs difference only exposes accessible_message_ids as pub(crate); it does not alter the discussed timeout/routing paths. Deployment-script changes must still be compared with the installed analytics bundle before rollout.

Evidence came from systemd journals, PostgreSQL daily logs, short pg_stat_statements snapshots, catalogs and plain EXPLAIN, ClickHouse query_log/settings/processes and EXPLAIN PLAN indexes=1, nginx error logs, service status, cgroup pressure, filesystems, and replication health. No expensive EXPLAIN ANALYZE search workload was added to the affected production systems. Diagnostic reads had bounded statement/execution timeouts.

## Errors

### PostgreSQL

| Since-midnight observation | Pivnich | Skhid |
| --- | ---: | ---: |
| Statement timeouts, approximately 07:30 cutoff | 877 | 84 |
| Explicitly classified text-search statements | 704 | 76 |
| Text-search share of timeouts | At least 80.3% | At least 90.5% |
| Lock timeouts, earlier approximately 07:29 snapshot | 29 | 85 |
| Deadlocks, earlier snapshot | 2 | 2 |
| Logged statements lasting at least 3 seconds, earlier snapshot | 6,026 | 3,110 |
| Ordinary runtime statement timeout | 30,000 ms | 50,000 ms |
| Lock timeout | 3,000 ms | 3,000 ms |
| Idle-in-transaction timeout | 120,000 ms | 120,000 ms |

Pivnich's statement-family classification totals 877:

| Statement family | Timeouts |
| --- | ---: |
| Text-search count/facet | 421 |
| Materialized analysis facet with text search | 106 |
| Text-search inbox | 177 |
| Message count/facet | 55 |
| Network selected materialized CTE | 2 |
| Inbox/message select | 10 |
| Other materialized analysis facet | 4 |
| messages_aor_cte | 9 |
| messages_cte | 82 |
| distinctfreq | 5 |
| filtered_items | 5 |
| Inbox-ID min/max | 1 |

Skhid's 84 comprise 49 text-search count/facet, 17 text-search inbox, 10 materialized text-search facets, 3 other filtered CTEs, 2 messages CTEs, and 3 inbox statements. Classification uses logged SQL shapes; some generic CTE families could also contain search.

An earlier Pivnich snapshot counted 865 timeouts: 18 at 00:00–00:59, 5 at 02:00–02:59, 3 at 03:00–03:59, 70 at 04:00–04:59, 47 at 05:00–05:59, 389 at 06:00–06:59, and 333 at 07:00 onward. These are an earlier cutoff, not an hourly breakdown of the later 877. Skhid recorded 1 at 02:00–02:59, 80 at 04:00–04:59, and 3 at 07:00 onward.

Slow-log maximum durations were approximately 19.7 minutes on Pivnich and 21.1 minutes on Skhid. They were not attributed to user requests; replication/protocol and worker statements can appear in these logs. They must not be presented as maximum page latency.

No currently blocked database sessions appeared in the activity snapshot. Brief background idle transactions existed, but historical lock timeouts/deadlocks do not establish a persistent lock blockade.

### Application mapping to HTTP 503

Relevant code: [analysis routing and timeout handling](../../../wdintel-rs/src/rer_importer/analysis/mod.rs), [HTTP error responses](../../../wdintel-rs/src/error.rs).

- analytics_count_request_supported rejects nonempty search and creation-time analysis requests from analytics eligibility.
- with_analytics_read_fallback_inner sends unsupported requests to PostgreSQL with reason=query_policy.
- map_postgres_runtime_timeout walks the error chain for SQLSTATE 57014 and returns AppError::ServiceUnavailable.
- The response is HTTP 503 with Retry-After: 1 and a Ukrainian message asking the user to narrow search parameters.
- Analytics errors/timeouts can open a circuit and redirect subsequent reads to PostgreSQL.

The first requested two-hour Pivnich journal extract contained 92 mapped runtime-timeout warnings and 92 Service unavailable messages, plus 11 internal-server-error messages. It also showed analytics errors/timeouts and circuit-open routing. Retention means it does not cover a complete two hours. Matching warning/response lines describe the same failure and must not be added together.

The later retained-journal extract on Skhid contained 84 mapped warnings and 84 Service unavailable messages, with the same hourly distribution as its PostgreSQL timeouts, plus one internal-server-error message. A circuit-open interval was visible near 03:58. Memory errors, fallback, and PostgreSQL timeouts establish a plausible load-amplification path; exact request-by-request causality was not reconstructed.

Both nginx access logs were disabled. PostgreSQL cancellation counts are not an exact HTTP 503 census, and the incident's HTTP error rate cannot be computed reliably.

### ClickHouse memory-limit failures

| Six-hour query-log observation | Pivnich | Skhid |
| --- | ---: | ---: |
| ExceptionWhileProcessing, code 241 | 22 | 5 |
| First exception | 05:01:58 | 03:58:41 |
| Last exception in sample | 07:25:10 | 05:06:22 |
| Server memory limit | 18,897,856,102 bytes, 17.60 GiB | Same |
| Configured memory/RAM ratio | 0.55 | 0.55 |
| Analytics-container RAM | 32 GiB | 32 GiB |

Pivnich's largest failed shape is normalized_query_hash 13450045655083050736, an AOR facet:

- 11 failures; maximum failed-query duration 22,353 ms.
- Initial maximum tracked memory: 15,013 MiB.
- A captured failed example read 6,431,451 rows and tracked 14,822,215,231 bytes.
- A later inspection recorded 16,597,863,180 bytes, approximately 15.46 GiB or 15,829 MiB, for the same shape under echo_gateway.
- The example recorded 338 thread IDs over its lifetime. This does not prove 338 simultaneously active threads.

Other Pivnich failures included a creation-time inbox candidate at 14,128 MiB (2 failures, hash 467186707879040199), an effective-time coalesce min/max query at 2,817 MiB (2 failures, hash 3676576133679306277), and ordinary duty/count/candidate queries at approximately 294–1,064 MiB. Exceptions explicitly report total-server memory and overcommit selection. Small victim queries are not necessarily the cause of pressure.

Fresh replication and healthy source slots do not imply sufficient analytics query capacity.

## PostgreSQL search analysis

The shared generator is [attachments/search.rs](../../../wdintel-rs/src/attachments/search.rs): text_predicate, exists_term, and message_filter. For each positive term it constructs message membership in a UNION of body sigint_search matches, media filename matches, and attachment_chunk matches joined to the current attachment_document revision and owning media/message.

Authorized groups and time filters are supplied elsewhere. The captured production plan aggregates the search union globally before joining it to the narrowed inbox/group set.

| Plan stage | Estimated rows |
| --- | ---: |
| Body GIN matches before date/group intersection | 777,435 |
| Aggregated body/media/chunk matches | 777,612 |
| Inbox rows found through datetime index | 767,937 |
| Date/group candidate intersection | 29,254 |
| Search/date/group intersection | 1,175 |
| Undeleted message candidates | 517 |
| Final permission semijoin output | 15 |

The plan uses existing GIN, trigram, datetime, and group/message indexes. The issue is the volume and repetition of work before selective intersection, not simply a missing text-search index. These are planner estimates; actual counts and attribution to an individual timeout remain unmeasured.

Two completed search-count variants in the 208-second window averaged 9.76 s and 8.87 s and together read 76,665.5 MiB of PostgreSQL shared blocks. Temporary work was also present. Separate facets can repeat similar matching work. Cancelled executions are not adequately represented by completed-query counters, so these figures understate the failing workload.

Rewrites must preserve AND/OR/negative terms, Russian stemming/prefixes, literal matching, numeric/frequency/message-UID handling, body/all/attachments/document scopes, current document revision, deletion, authorization, and request-specific time semantics. Candidate-first probes may suit narrow scopes; GIN-first matching may remain better for selective terms over wide scopes. Benchmark both.

## Analytics analysis

The endpoint is [aor_stats](../../../wdintel-rs/src/rer_importer/analysis/mod.rs). Query builders are in [analysis/stats.rs](../../../wdintel-rs/src/rer_importer/analysis/stats.rs): build_aors_analytics_query_with_scope and build_aor_messages_query. The ClickHouse link view comes from [reconcile-derived-schema.sh](../../../deploy/clickhouse/bin/reconcile-derived-schema.sh).

The facet joins inbox, messages, posts, message-group rows, derived AOR links, and AOR metadata, then counts distinct message IDs per top-level nondeleted AOR. The link view uses UNION ALL across group-AOR and network-AOR branches. Both membership sources can multiply rows per message/AOR; COUNT(DISTINCT message_id) preserves counts despite that fan-out.

The captured plan contains multiple FillRightFirst joins and does prune large relations:

| Relation/branch | Reported granules after relevant pruning |
| --- | --- |
| Inbox | 168 / 5,982 |
| Message-group source | 213 / 6,822 under min/max; later stage reports 214 / 213 |
| Derived message-network links | 175 / 12,133 |
| Message source | 239 / 4,667 |

The unusual 214/213 value is copied from planner output, not measured rows. Group-link data is read in multiple branches, including the UNION under the derived view. Investigate hash-build size, duplicate multiplication, column width, and filtering within each branch. The plan does not attribute the complete memory peak to an individual join.

Recent-window ID scopes intentionally have only a lower bound; closed historical windows can use both. Adding upper bounds everywhere could omit late-arriving/replicated messages. Timestamp predicates remain authoritative.

### Resource controls

A follow-up authenticated directly as echo_gateway using deployment secrets internally. Both deployments returned these default-session settings; no credentials were copied:

| Gateway setting | Both deployments |
| --- | --- |
| max_threads | auto(32) |
| max_memory_usage | 0 |
| max_memory_usage_for_user | 0 |
| max_concurrent_queries_for_user | 0 |
| max_execution_time | 0 |
| max_bytes_before_external_group_by | 0 |
| join_algorithm | direct,parallel_hash,hash |

The settings-profile catalog showed no explicit echo_gateway resource-limit elements. New-session defaults do not prove every statement's overrides. The captured failed AOR query's Settings map did not contain max_threads or max_memory_usage overrides.

Server settings included max_concurrent_queries=1000, max_thread_pool_size=10000, concurrent_threads_soft_limit_num=0, and concurrent_threads_soft_limit_ratio_to_cores=2. Application analytics pools default to 16 connections. PostgreSQL analytics-error fallback already has a process-local limit of 8 and 250 ms queue timeout, but reason=query_policy bypasses that gate. These controls do not bound total ClickHouse memory across processes or unsupported search load on PostgreSQL.

The earlier admin diagnostic used max_execution_time=8. That is a diagnostic override, not a production gateway limit.

### Other expensive shapes

Pivnich unit-filtered count hash 12538874956141255527 ran 139 times in approximately 15 minutes: mean 2,949 ms, p95 7,090 ms, up to 128,458,126 rows per query, approximately 549 GiB cumulative logical reads. Its memory peak was smaller than AOR's, but repeated scans add CPU/read pressure.

Analytics datetime min/max hash 13303863780514434858 ran 314 times: mean 1,148 ms, p95 2,707 ms, up to 35,766,865 rows per query. Existing bounds caches do not remove this workload. Measure parameters, time-basis changes, cache hit rates, process count, and source-versus-analytics execution before changing caching.

## Background and repeated-request work

### Network last-seen recalculation

[recalculate_last_seen](../../../wdintel-rs/src/sigint/network/recalculation.rs) builds a materialized frequency target, joins network links to inbox/messages, filters frequency/effective time, takes MAX(COALESCE(ii.datetime, sm.timestamp, sm.created_at)), then updates last_seen_dt.

Completed calls averaged 23.22 s on Pivnich and 5.21 s on Skhid. At approximately 07:24, Pivnich had 529 queued last-seen tasks, oldest 05:48:16, and 141 AOR-cache tasks, oldest approximately 06:07. Skhid had 11 recent last-seen tasks.

The worker already batches by network, uses SKIP LOCKED and advisory/row locks, and batches up to 500 frequencies. Constants include a 60-second interval, 50-second run budget, and 300,000 ms recalculation statement timeout. Checks between jobs do not bound an individual query to the run budget. COALESCE time conditions can obstruct direct use of the existing frequency/datetime index.

### OCR queue positions

[load_queue_positions](../../../wdintel-rs/src/ocr/mod.rs) computes and loads the entire queue into a HashMap. It unions submitted jobs, queued/retry-wait jobs, and eligible recent media without jobs, excludes deleted messages, then ranks the global queue.

Summary/status/reprocessing paths call it repeatedly. The window contained 181 Pivnich calls averaging 615.7 ms and 203 Skhid calls averaging 961.4 ms. Skhid accumulated 195.2 execution seconds with zero shared-block-read delta; cached-page/CPU work remains costly.

The queue_positions_count_only_items_ahead regression protects meaningful behavior. Preserve submitted priority, timestamp/null order, retry eligibility, pending discovery, deterministic media-ID ties, and authorization before returning media status.

### Duplicate group links

Skhid completed 15 calls of query ID 8828733985668082866: mean 3.73 s, 87,111.4 MiB shared reads. Pivnich completed 5: mean 4.18 s, 18,027.0 MiB reads.

delete_previous_duplicate_group_links in [messenger/reconcile.rs](../../../wdintel-rs/src/messenger/reconcile.rs) finds group-link rows by exact datasource_group_id, created_at, sender, plus signal_message_id inequality. Current indexes target group_master_key/signal_message_id; the datasource index is restricted to group_master_key IS NULL. No general index matches this lookup.

Follow-up plain EXPLAIN with synthetic nonmatching values selected parallel sequential scans on both databases. This confirms an unindexed predicate shape, not actual execution with incident parameters. Ambiguous matches are deliberately skipped and that safeguard must survive optimization.

### Bounds, permissions, and settlement lookup

The creation-time ID min/max query completed 1,529 Pivnich and 1,114 Skhid calls in 208 seconds. Source: [inbox/query.rs](../../../wdintel-rs/src/rer_importer/inbox/query.rs), load_inbox_message_id_bounds_uncached. OFFSET 0 deliberately avoids pathological primary-key min/max scans ignoring the selective time index.

Inbox and analysis bounds already use pool-aware caches/singleflight with 5-second TTL and 2,048-entry limits. Adding a generic cache would duplicate existing behavior; inspect keys, callers, time-range churn, and hit rates.

Permission-group lookup completed approximately 40,000–44,000 calls per deployment: low single-call cost but 96.5 s cumulative execution on Pivnich and 42.7 s on Skhid. Request-local reuse or correctly invalidated permission snapshots are candidates; an unversioned cross-user cache risks stale authorization.

Skhid query ID -3520703590422063962 calculates ST_Distance and cardinal direction for settlement WHERE tag IS NULL, sorts by distance, and limits the result. It completed 265 calls averaging 347 ms. Existing partial geography GiST indexes do not match the observed FORMAT-based distance expression as a spatial filter. Its exact producer was not located in inspected Rust source. It is distinct from settlement/resolution.rs, which already uses ST_DWithin; trace the caller/dependency before editing.

## Database scale, indexes, and maintenance

Follow-up catalog estimates around 07:40–07:47 are below. Live/dead counts are statistics, not exact counts. Total size includes indexes/TOAST.

| Relation | Pivnich live rows | Pivnich total MiB | Skhid live rows | Skhid total MiB |
| --- | ---: | ---: | ---: | ---: |
| sigint_inbox_item | 19,334,509 | 29,660.9 | 30,615,180 | 50,972.1 |
| signal_message | 24,716,791 | 30,904.6 | 35,266,427 | 44,810.7 |
| signal_message_group | 31,896,717 | 11,016.3 | 38,778,821 | 16,964.4 |
| sigint_search | 18,149,794 | 9,857.6 | 29,515,092 | 15,394.8 |
| sigint_inbox_item_network | 13,210,538 | 5,647.5 | 4,467,641 | 1,887.8 |
| ocr_job | 19,948 | 7.4 | 29,760 | 11.9 |
| settlement | 40,778 | 9.4 | 40,687 | 9.7 |

Earlier estimates were close but not identical. Skhid search statistics changed during follow-up, including autovacuum at 07:38. Estimate changes are not exact ingestion/deletion counts.

Relevant deployed indexes, present on both:

| Relation | Existing access paths |
| --- | --- |
| sigint_search | Primary key(id), GIN(search_tsv) |
| signal_message_media | Primary key(id), btree(signal_message_id), btree(created_at,id), GIN(file_name gin_trgm_ops) |
| attachment_chunk | Unique(media_id,revision,ordinal), GIN(search_tsv), GIN(text gin_trgm_ops), GIN(member gin_trgm_ops) |
| sigint_inbox_item | Primary key(id), (datetime,id), datetime DESC, freq, (freq,datetime) INCLUDE(id) WHERE datetime IS NOT NULL, (freq,id) WHERE datetime IS NULL, (unit_v2,datetime) INCLUDE(id) for nonempty units |
| signal_message | Primary key(id), (created_at,id), (timestamp,id), (datasource_group_id,created_at,id), (datasource_group_id,timestamp), identifier and single-column indexes |
| signal_message_group | (group_master_key,signal_message_id), (signal_message_id,group_master_key), group_master_key, partial (datasource_group_id,signal_message_id) WHERE group_master_key IS NULL |
| sigint_inbox_item_network | Unique(sigint_network_id,sigint_inbox_item_id), sigint_network_id, sigint_inbox_item_id, (sigint_network_id,created_at DESC) |
| ocr_job | Primary key(media_id), due(next_attempt_at,discovered_at,media_id) for queued/retry_wait, latest(updated_at DESC,media_id), nonterminal engine index |
| settlement | GiST((ST_SetSRID(ST_MakePoint(lon,lat),4326))::geography) WHERE lat and lon are nonnull |

Equivalent index names sometimes differ; compare definitions.

PostgreSQL work_mem was 8 MiB; shared_buffers 6/8 GiB and effective_cache_size 24/28 GiB for Pivnich/Skhid. max_parallel_workers_per_gather=2 and log_min_duration_statement=3,000 ms.

Skhid sigint_search last_autoanalyze remained 2026-09-17. signal_message had approximately 2,461,499 dead tuples, last_autovacuum 2026-10-03 and last_autoanalyze 2026-10-11; Pivnich's message estimate was 784,131 dead tuples. Check maintenance thresholds, active vacuum progress, old snapshots, and table-specific settings. These statistics do not establish measured bloat or explain the incident by themselves. No maintenance or index creation was run.

## Health and capacity

| Observation | Pivnich | Skhid |
| --- | --- | --- |
| Public ping | 12/12 HTTP 200; median 172 ms, max 225 ms | 12/12 HTTP 200; median 175 ms, max 222 ms |
| Root/server-info probes | HTTP 200 | HTTP 200 |
| API active since | 2026-10-11 11:29:02 | 2026-10-11 11:05:15 |
| API NRestarts since activation | 0 | 0 |
| Background/report services | Active; no failed units in snapshot | Same |
| Fresh gateway heartbeat around 07:22 | 07:22:05 | 07:22:02 |
| Source logical slot | Active; approximately 175 kB lag | Active; approximately 365 kB lag |
| Application RAM / available | Approximately 71 GiB / 28 GiB | Approximately 49 GiB / 6.3 GiB |
| Application root usage / available | 69% / 127 GB | 38% / 290 GB |
| Analytics RAM / available | 32 GiB / approximately 19 GiB | 32 GiB / approximately 22 GiB |
| Analytics root usage / available | 53% / 236 GB | 74% / 159 GB |
| Swap | None | None |
| Application memory PSI | 0 in snapshot | 0 in snapshot |
| Analytics CPU PSI some avg60 / avg300 | 50.10% / 46.20% | 13.81% / 14.78% |
| Application CPU PSI some avg60 | Approximately 14% | Approximately 4.8% |
| Application I/O PSI some avg60 | Approximately 3.8% | Approximately 1.6% |

Analytics exposed 32 CPUs with no cpu.max quota. One snapshot showed 16 active ClickHouse queries on Pivnich, longest approximately 4.4 seconds, versus 3 on Skhid. These are instantaneous observations, not peaks.

PSI measures resource stall time, not CPU utilization. Host load averages are not reliable per-container CPU utilization. Historical cgroup OOM-kill counters (126 Pivnich, 430 Skhid) are cumulative, not proof of an OOM during this incident. The samples did not support API restarts, disk exhaustion, current application memory pressure, or sustained replication failure as the primary cause.

PostgreSQL max_connections was 150 on Pivnich/300 on Skhid. Web/background/report pools were 50/20/20; they were not all active in the sample. Expanding pools would not remove query cost.

## nginx and observability

At approximately 07:22, Pivnich had 7 upstream-too-big-header events today and Skhid 1. Most involved logout with large serialized redirect state; one involved the delta redirect/authentication path. Such response-header failures normally produce 502-class proxy errors, separate from the confirmed PostgreSQL-to-503 mapping. Actual headers and status-level correlation were not captured.

The nginx templates configure large client request-header buffers, but no explicit proxy_buffer_size. Request-header buffers do not repair oversized upstream response headers. Fix redirect payloads, or measure and use a bounded intermediate response-buffer adjustment.

Two Pivnich and one Skhid upstream-premature-close events involved an AI/provider stream. Their cause was not established and they should not be folded into the database diagnosis.

Pivnich journald used RuntimeMaxUse=100M and SystemMaxUse=0, retaining approximately 108 MiB. A 24-hour request around 07:23 actually returned history beginning at 07:18. Skhid retained approximately 1.4 GiB with history beginning at 01:28. Requested and available windows differ substantially.

Central SigNoz freshness was not independently checked. Daily PostgreSQL logs supplied longer history. Log retention, exact HTTP status counts, request correlation, queue time, cancellation propagation, and cache hit/miss telemetry remain gaps.

## Caveats and reproducibility

1. Counter snapshots were matched on userid, queryid, and toplevel within the fixed wd database. queryid alone is not unique. An initial queryid-only comparison produced impossible deltas and was discarded; only the corrected full-key window appears here.
2. Cumulative execution seconds add concurrent completed statements; they are neither incident duration nor CPU seconds. Pivnich accumulated approximately 2,731.9 s and Skhid 1,118.9 s over approximately 208 wall-clock seconds.
3. PostgreSQL shared reads can be served from OS/filesystem caches and are not direct physical-disk measurements. ClickHouse read_bytes are logical reads.
4. Completed-query counters underrepresent cancellations; timeout logs and exceptions complement them.
5. Plain EXPLAIN and planned granules are not actual-execution measurements.
6. Different windows/workloads and retention prevent an apples-to-apples host benchmark. Skhid is not an identical control environment.
7. No pre-October-10 deployment baseline was recovered. Timing alone does not prove a release regression.
8. Search text, group selections, message content, redirect URLs, auth codes, credentials, and session-specific agent paths are omitted. Bound identifiers and literals in archived plans are redacted.

Repeat reads through the existing SSH agent and aliases. Use sudo -u postgres on each deployment instead of embedding a password. Determine the pg_stat_statements extension schema first, bound each diagnostic, record timestamps/reset metadata, and do not reset counters.

Start with a read-only transaction and plain EXPLAIN. Obtain actual-plan evidence on a restored production-scale database following [QUERY_PERF.md](../../../QUERY_PERF.md):

~~~sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '8s';
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)
SELECT ...;
ROLLBACK;
~~~

This is a diagnostic template, not executable workload SQL. Never EXPLAIN ANALYZE production UPDATE/DELETE/INSERT. Benchmark worker SELECT equivalents on the restored database.

Appendices below preserve measured query summaries, retained application-route timings, and sanitized plan trees without depending on temporary investigation files.

## Appendix A: completed PostgreSQL statement deltas

Matched snapshots: Pivnich 07:24:21.413550–07:27:49.598835 (208.185 s); Skhid 07:24:21.460466–07:27:49.339581 (207.879 s). Read MiB is shared_blks_read delta × 8 KiB; temp MiB is temp_blks_written delta × 8 KiB. Execution-time means are derived from completed calls in this window, not lifetime means. Query IDs can differ between SQL variants/deployments.

### echo-pivnich

| Query ID | Family / SQL prefix | Calls | Total s | Mean ms | Read MiB | Temp written MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 3572258331169442282 | Creation-time message-ID min/max | 1529 | 199.7 | 130.6 | 10071.5 | 0.0 |
| -3248399419679346841 | Batched network last-seen | 8 | 185.8 | 23221.0 | 9438.2 | 0.0 |
| -7339233829113571647 | Text-search message count | 12 | 117.2 | 9764.7 | 37562.0 | 73.1 |
| -1345270738235068848 | Text-search message count variant | 13 | 115.3 | 8866.6 | 39103.5 | 482.5 |
| -3716218853564675930 | Global OCR queue rank | 181 | 111.4 | 615.7 | 844.3 | 0.0 |
| 6492623752933455025 | Message/inbox/group listing | 35 | 96.7 | 2763.6 | 10229.6 | 0.0 |
| -5793020850987179997 | Authorized group lookup | 39979 | 96.5 | 2.4 | 0.0 | 0.0 |
| -4558484742334478479 | SQL prefix: SELECT "signal_message"."id" AS "id", "signal_message"."id_uuid" AS "id_uuid", "signa… | 289 | 92.9 | 321.3 | 61.2 | 0.0 |
| 3735437045196031626 | SQL prefix: SELECT DISTINCT "signal_message"."id", "signal_message"."timestamp", "signal_message"… | 65 | 90.0 | 1385.1 | 2424.5 | 0.0 |
| 8300488106286013415 | SQL prefix: SELECT "signal_message"."id", "signal_message"."created_at", "signal_message"."timest… | 35 | 86.8 | 2478.7 | 16541.9 | 0.0 |
| -3179076149632303443 | SQL prefix: SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM (SELECT id FROM signal_message WHERE… | 844 | 81.7 | 96.8 | 2582.8 | 0.0 |
| -2543732411149314714 | SQL prefix: select *, ST_Distance($1::geography, FORMAT($2, lon, lat)::geography) as distance, CO… | 202 | 78.0 | 386.3 | 40.7 | 0.0 |
| 8828733985668082866 | Duplicate group-link lookup | 5 | 20.9 | 4182.8 | 18027.0 | 0.0 |

All matched positive deltas: 1506 entries; approximately 2731.9 execution seconds and 218712.3 MiB shared reads. Table shows the leading completed-execution entries plus the identified incident-relevant shapes; it is not every statement.

### echo-skhid

| Query ID | Family / SQL prefix | Calls | Total s | Mean ms | Read MiB | Temp written MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 7793311616869653648 | Global OCR queue rank | 203 | 195.2 | 961.4 | 0.0 | 0.0 |
| 1934484142945490860 | Network last-seen | 29 | 151.0 | 5205.7 | 17657.5 | 22.0 |
| -3520703590422063962 | Nearest settlement distance sort | 265 | 92.0 | 347.0 | 0.0 | 0.0 |
| 8828733985668082866 | Duplicate group-link lookup | 15 | 56.0 | 3733.3 | 87111.4 | 0.0 |
| 3572258331169442282 | Creation-time message-ID min/max | 1114 | 49.6 | 44.5 | 0.0 | 0.0 |
| -8487215064468631480 | Authorized group lookup | 43837 | 42.7 | 1.0 | 0.0 | 0.0 |
| 4677182215929232706 | SQL prefix: SELECT "comp_freq_callsign"."id", "comp_freq_callsign"."zone_id", "comp_freq_callsign… | 399 | 36.1 | 90.4 | 0.0 | 0.0 |
| 2650968721849975448 | SQL prefix: SELECT COUNT(*) AS "count", MIN("signal_message"."timestamp") AS "first_element_ts" F… | 34 | 35.4 | 1041.7 | 1693.9 | 0.0 |
| 4377138186147039220 | Login entity lookup | 23930 | 33.4 | 1.4 | 0.0 | 0.0 |
| -8775946595035416805 | SQL prefix: SELECT "echo_group"."id", "echo_group"."group_id", "echo_group"."internal_id", "echo_… | 8245 | 30.9 | 3.7 | 0.0 | 0.0 |
| 6548822120911682254 | SQL prefix: SELECT "sigint_inbox_item_settlement"."id", "sigint_inbox_item_settlement"."created_a… | 68 | 21.7 | 319.5 | 0.0 | 0.0 |
| -4896705906369840988 | SQL prefix: SELECT COUNT(*) AS "count", MIN("signal_message"."timestamp") AS "first_element_ts" F… | 57 | 18.4 | 322.5 | 0.0 | 0.0 |

All matched positive deltas: 1282 entries; approximately 1118.9 execution seconds and 151416.0 MiB shared reads. Table shows the leading completed-execution entries plus the identified incident-relevant shapes; it is not every statement.

## Appendix B: ClickHouse completed-query samples

Approximately 07:12–07:27. Aggregated by normalized_query_hash. These finished-query summaries are distinct from the six-hour exceptions and the application-route timings. MiB means 2^20 bytes.

### echo-pivnich

| Normalized hash | Calls | Mean ms | p95 ms | Max ms | Max rows/query | Total rows read | Total read MiB | Peak tracked MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 16756311264435566619 | 4204 | 210 | 427 | 1065 | 702408 | 252234546 | 9015 | 294 |
| 12538874956141255527 | 139 | 2949 | 7090 | 8080 | 128458126 | 17854734543 | 561908 | 486 |
| 13303863780514434858 | 314 | 1148 | 2707 | 3780 | 35766865 | 11230592562 | 235936 | 289 |
| 2962399885350632838 | 2483 | 144 | 309 | 628 | 128763 | 18096700 | 598 | 294 |
| 3190094928365006125 | 331 | 880 | 2817 | 6074 | 29797664 | 3055750190 | 110422 | 1122 |
| 17055423705417735429 | 1323 | 212 | 408 | 1212 | 99579 | 50779470 | 1711 | 293 |
| 5728870773261580443 | 988 | 257 | 638 | 1831 | 2329079 | 278513764 | 8978 | 294 |
| 9230461124834648710 | 358 | 704 | 1474 | 2963 | 3047583 | 1086693665 | 27054 | 513 |

### echo-skhid

| Normalized hash | Calls | Mean ms | p95 ms | Max ms | Max rows/query | Total rows read | Total read MiB | Peak tracked MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2962399885350632838 | 13269 | 53 | 112 | 330 | 30697 | 92542503 | 4801 | 294 |
| 5728870773261580443 | 1350 | 100 | 236 | 1019 | 1656535 | 455734400 | 15856 | 294 |
| 11276230917870867397 | 502 | 251 | 553 | 1097 | 42162881 | 9243835821 | 291437 | 409 |
| 13779316584521460697 | 237 | 360 | 758 | 1858 | 40932903 | 7855554308 | 247155 | 343 |
| 5170037384450364208 | 1114 | 54 | 120 | 218 | 47183 | 9075283 | 469 | 294 |
| 17419845927459987970 | 123 | 482 | 952 | 1739 | 41825706 | 5057833202 | 159159 | 245 |
| 8475168504006006990 | 82 | 570 | 1090 | 1339 | 76498202 | 5288564970 | 153424 | 345 |
| 16756311264435566619 | 592 | 74 | 170 | 255 | 52468 | 11984245 | 543 | 294 |

### Failed Pivnich fingerprints, six-hour sample

| Normalized hash | Failures | Max failed duration ms | Peak tracked MiB |
| --- | ---: | ---: | ---: |
| 13450045655083050736 | 11 | 22353 | 15013 |
| 467186707879040199 | 2 | 15876 | 14128 |
| 3676576133679306277 | 2 | 3095 | 2817 |
| 16756311264435566619 | 1 | 174 | 294 |
| 3190094928365006125 | 1 | 1359 | 1064 |
| 2962399885350632838 | 1 | 69 | 294 |

The AOR fingerprint subsequently reached 15,829 MiB in a later sample; the table preserves the earlier six-hour aggregation. Exception grouping shown here covers the captured leading shapes, not necessarily all 22 events.

## Appendix C: retained application-route timings

The diagnostic requested 24 hours, but actual retained coverage is below. Counts are route-log events, not unique HTTP requests. Percentiles use only events with elapsed_ms and may include errors. Route counts can include untimed selection records. Timing is for the logged operation boundary, which may include multiple statements; it is not isolated ClickHouse execution time or end-to-end browser latency. The saved summaries retain the 35 most frequent route/operation/reason combinations per host. Values of 0 ms can reflect sub-millisecond work or timing only a small part of routing; missing timing is marked unavailable.

### echo-pivnich

Actual coverage: 2026-10-12T07:18:00Z through 2026-10-12T07:23:18Z; 12469 journal lines. Mapped timeout warnings: 20.

| Operation | Route | Reason | Events | p50 ms | p95 ms | Max ms | Timed events >3s |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| rer duty inbox messages count | analytics | - | 3682 | 494 | 3696 | 20568 | 294 |
| inbox message candidates | analytics | - | 2082 | 186 | 1926 | 12942 | 33 |
| group activity enrichment | analytics | - | 127 | 821 | 3876 | 5746 | 12 |
| inbox messages count | postgres | query_policy | 126 | 188 | 14067 | 25674 | 37 |
| analysis stats tags | postgres | query_policy | 42 | 857 | 30007 | 30014 | 13 |
| analysis stats groups | postgres | query_policy | 32 | 1929 | 30002 | 30051 | 13 |
| analysis stats senders | postgres | query_policy | 27 | 1026 | 14127 | 21858 | 8 |
| analysis stats senders count | analytics | - | 17 | 3522 | 8661 | 12114 | 9 |
| analysis stats groups count | analytics | - | 17 | 3536 | 8978 | 13904 | 9 |
| analysis stats freqs count | analytics | - | 17 | 3489 | 8950 | 12049 | 9 |
| network group activity | analytics | - | 16 | 6242 | 12634 | 13411 | 14 |
| analysis stats aors count | analytics | - | 15 | 1741 | 6926 | 10092 | 4 |
| analysis stats networks count | analytics | - | 15 | 1962 | 5750 | 18324 | 5 |
| analysis stats units count | analytics | - | 15 | 7242 | 18186 | 20091 | 15 |
| analysis stats posts count | analytics | - | 14 | 1372 | 8861 | 9726 | 3 |
| analysis stats locations count | analytics | - | 14 | 919 | 6070 | 8887 | 4 |
| analysis stats callsigns count | analytics | - | 14 | 1092 | 7772 | 9594 | 3 |
| analysis stats tags count | analytics | - | 14 | 1357 | 6661 | 9721 | 4 |
| analysis stats messages count | analytics | - | 13 | 4113 | 8225 | 8690 | 8 |
| analysis stats freqs count | postgres | query_policy | 13 | 96 | 30004 | 30013 | 4 |
| analysis stats posts count | postgres | query_policy | 13 | 131 | 11910 | 16239 | 3 |
| analysis stats tags | analytics | - | 13 | 3749 | 7907 | 9528 | 8 |
| analysis stats senders count | postgres | query_policy | 12 | 99 | 5572 | 19057 | 3 |
| analysis stats groups count | postgres | query_policy | 12 | 135 | 8941 | 20954 | 2 |
| analysis stats freqs | postgres | query_policy | 11 | 10472 | 42472 | 59184 | 10 |
| analysis stats callsigns count | postgres | query_policy | 10 | 79 | 230 | 16154 | 1 |
| analysis stats units count | postgres | query_policy | 10 | 116 | 928 | 29619 | 1 |
| analysis stats locations count | postgres | query_policy | 10 | 70 | 341 | 15338 | 1 |
| analysis stats tags count | postgres | query_policy | 9 | 63 | 248 | 377 | 0 |
| analysis stats aors count | postgres | query_policy | 9 | 94 | 313 | 3167 | 1 |
| analysis stats networks count | postgres | query_policy | 9 | 71 | 217 | 392 | 0 |
| analysis stats networks | postgres | query_policy | 9 | 30002 | 30012 | 30039 | 5 |
| analysis stats messages count | postgres | query_policy | 4 | 43 | 44 | 219 | 0 |
| analysis stats posts | postgres | query_policy | 4 | 976 | 1202 | 1248 | 0 |
| analysis stats freqs | analytics | - | 3 | 14420 | 14420 | 15995 | 3 |

Timeout warnings by operation: analysis stats groups=5, analysis stats networks=5, analysis stats tags=5, analysis stats freqs count=3, analysis stats freqs=2.

### echo-skhid

Actual coverage: 2026-10-12T01:28:03Z through 2026-10-12T07:23:33Z; 1573145 journal lines. Mapped timeout warnings: 84.

| Operation | Route | Reason | Events | p50 ms | p95 ms | Max ms | Timed events >3s |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| inbox message candidates | analytics | - | 282483 | 50 | 130 | 9174 | 80 |
| rer duty inbox messages count | analytics | - | 126076 | 114 | 767 | 15449 | 332 |
| group activity enrichment | analytics | - | 5963 | 0 | 2 | 1154 | 0 |
| report history dashboard | analytics | - | 1697 | 29 | 77 | 221 | 0 |
| inbox message candidates | postgres | circuit_open | 974 | 0 | 0 | 0 | 0 |
| analysis stats tags | analytics | - | 306 | 1266 | 2360 | 9307 | 10 |
| analysis stats senders count | analytics | - | 248 | 544 | 1958 | 3930 | 3 |
| analysis stats groups count | analytics | - | 248 | 576 | 2004 | 4044 | 2 |
| analysis stats freqs count | analytics | - | 246 | 499 | 1929 | 3662 | 2 |
| analysis stats posts count | analytics | - | 236 | 230 | 1143 | 3471 | 1 |
| analysis stats callsigns count | analytics | - | 229 | 236 | 1441 | 3953 | 1 |
| analysis stats locations count | analytics | - | 228 | 205 | 1101 | 2458 | 0 |
| analysis stats units count | analytics | - | 228 | 943 | 2409 | 4441 | 4 |
| analysis stats tags count | analytics | - | 227 | 320 | 1283 | 2265 | 0 |
| analysis stats aors count | analytics | - | 226 | 348 | 1119 | 2032 | 0 |
| analysis stats networks count | analytics | - | 225 | 623 | 1774 | 3095 | 1 |
| analysis stats tags | postgres | query_policy | 203 | 121 | 36277 | 50009 | 52 |
| rer duty inbox messages count | postgres | circuit_open | 173 | 16 | 2235 | 5828 | 3 |
| analysis stats messages count | analytics | - | 165 | 598 | 1969 | 4306 | 1 |
| analysis stats freqs | analytics | - | 136 | 1803 | 2993 | 4607 | 7 |
| analysis stats unit matches count | analytics | - | 95 | 1210 | 2215 | 3892 | 2 |
| inbox messages count | postgres | query_policy | 89 | 2377 | 2885 | 6484 | 3 |
| analysis stats posts | postgres | query_policy | 84 | 666 | 963 | 1232 | 0 |
| analysis stats count | analytics | - | 82 | 2516 | 9851 | 23651 | 35 |
| analysis stats freqs count | postgres | query_policy | 66 | 838 | 37794 | 50011 | 29 |
| analysis stats senders count | postgres | query_policy | 66 | 847 | 50003 | 50005 | 24 |
| analysis stats groups count | postgres | query_policy | 66 | 453 | 50002 | 50009 | 23 |
| analysis stats posts count | postgres | query_policy | 61 | 371 | 50003 | 50008 | 18 |
| analysis stats messages count | postgres | query_policy | 56 | 465 | 36511 | 50065 | 15 |
| analysis stats freqs | postgres | query_policy | 54 | 7047 | 61340 | 65571 | 46 |
| analysis stats callsigns count | postgres | query_policy | 51 | 244 | 38425 | 50004 | 8 |
| inbox message candidates | postgres | query_policy | 51 | 0 | 0 | 0 | 0 |
| analysis stats groups | analytics | - | 48 | 1297 | 3947 | 4887 | 7 |
| analysis stats groups | postgres | query_policy | 47 | 46 | 50001 | 50004 | 8 |
| analysis stats units count | postgres | query_policy | 45 | 323 | 2149 | 73961 | 3 |

Timeout warnings by operation: analysis stats units count=1, inbox messages=20, analysis stats groups count=12, analysis stats senders count=9, analysis stats senders=4, analysis stats tags=10, analysis stats groups=5, analysis stats freqs count=4, analysis stats posts count=7, analysis stats freqs=5, analysis stats callsigns count=3, analysis stats messages count=1, analysis stats networks=2, analysis stats units=1.

## Appendix D: sanitized PostgreSQL search plan

Plain EXPLAIN tree from the affected Pivnich query. Values are planner estimates. Search/group/date literals are redacted. No actual execution was requested.

~~~text
{"Node Type": "Aggregate", "Plan Rows": "1", "Total Cost": "940921.59"}
  {"Node Type": "Nested Loop", "Join Type": "Semi", "Plan Rows": "15", "Total Cost": "940921.51"}
    {"Node Type": "Nested Loop", "Join Type": "Inner", "Plan Rows": "517", "Total Cost": "939053.71"}
      {"Node Type": "Hash Join", "Join Type": "Inner", "Plan Rows": "1175", "Total Cost": "936788.07", "Hash Cond": "(body_search.id = sigint_inbox_item.id)"}
        {"Node Type": "Aggregate", "Plan Rows": "777612", "Total Cost": "775755.81"}
          {"Node Type": "Append", "Plan Rows": "777612", "Total Cost": "737725.72"}
            {"Node Type": "Gather", "Plan Rows": "777435", "Total Cost": "733157.92"}
              {"Node Type": "Bitmap Heap Scan", "Relation Name": "sigint_search", "Plan Rows": "323931", "Total Cost": "654414.42"}
                {"Node Type": "Bitmap Index Scan", "Index Name": "sigint_search_tsv_idx", "Plan Rows": "777435", "Total Cost": "4712.7", "Index Cond": "(search_tsv @@ '[redacted]'::tsquery)"}
            {"Node Type": "Bitmap Heap Scan", "Relation Name": "signal_message_media", "Plan Rows": "176", "Total Cost": "498.28"}
              {"Node Type": "Bitmap Index Scan", "Index Name": "attachment_media_name_idx", "Plan Rows": "176", "Total Cost": "303.57", "Index Cond": "(file_name ~~* '[redacted]'::text)"}
            {"Node Type": "Nested Loop", "Join Type": "Inner", "Plan Rows": "1", "Total Cost": "181.47"}
              {"Node Type": "Nested Loop", "Join Type": "Inner", "Plan Rows": "1", "Total Cost": "179.25"}
                {"Node Type": "Bitmap Heap Scan", "Relation Name": "attachment_chunk", "Plan Rows": "57", "Total Cost": "65.6"}
                  {"Node Type": "Bitmap Index Scan", "Index Name": "attachment_chunk_search_idx", "Plan Rows": "57", "Total Cost": "10.01", "Index Cond": "(search_tsv @@ '[redacted]'::tsquery)"}
                {"Node Type": "Index Scan", "Relation Name": "attachment_document", "Index Name": "attachment_document_pkey", "Plan Rows": "1", "Total Cost": "1.98", "Index Cond": "(media_id = chunk.media_id)", "Filter": "(chunk.revision = revision)"}
              {"Node Type": "Index Scan", "Relation Name": "signal_message_media", "Index Name": "signal_message_media_pkey", "Plan Rows": "1", "Total Cost": "2.21", "Index Cond": "(id = doc.media_id)"}
        {"Node Type": "Hash", "Plan Rows": "29254", "Total Cost": "157738.79"}
          {"Node Type": "Gather", "Plan Rows": "29254", "Total Cost": "157738.79"}
            {"Node Type": "Hash Join", "Join Type": "Inner", "Plan Rows": "12189", "Total Cost": "153813.39", "Hash Cond": "(sigint_inbox_item.id = signal_message_group_1.signal_message_id)"}
              {"Node Type": "Index Only Scan", "Relation Name": "sigint_inbox_item", "Index Name": "sigint_inbox_item_datetime_id_idx", "Plan Rows": "767937", "Total Cost": "101686.88", "Index Cond": "((datetime >= '[redacted]'::timestamp without time zone) AND (datetime <= '[redacted]'::timestamp without time zone) AND (datetime >= '[redacted]'::timestamp with time zone) AND (datetime <= '[redacted]'::timestamp with time zone))"}
              {"Node Type": "Hash", "Plan Rows": "250753", "Total Cost": "46012.87"}
                {"Node Type": "Unique", "Plan Rows": "250753", "Total Cost": "46012.87"}
                  {"Node Type": "Sort", "Plan Rows": "307319", "Total Cost": "45244.57"}
                    {"Node Type": "Index Only Scan", "Relation Name": "signal_message_group", "Index Name": "signal_message_group_group_master_key_signal_message_id_idx", "Plan Rows": "307319", "Total Cost": "14003.05", "Index Cond": "(group_master_key = ANY ('[redacted]'::text[]))"}
      {"Node Type": "Index Scan", "Relation Name": "signal_message", "Index Name": "signal_message_pkey", "Plan Rows": "1", "Total Cost": "1.93", "Index Cond": "(id = sigint_inbox_item.id)", "Filter": "(NOT deleted)"}
    {"Node Type": "Index Only Scan", "Relation Name": "signal_message_group", "Index Name": "signal_message_group_signal_message_id_group_master_key_idx", "Plan Rows": "28", "Total Cost": "83.73", "Index Cond": "((signal_message_id = signal_message.id) AND (group_master_key = ANY ('[redacted]'::text[])))"}
~~~

## Appendix E: sanitized ClickHouse AOR plan

Captured failed-query fingerprint 13450045655083050736. The following SQL is normalized diagnostic output with placeholders, not executable SQL:

~~~sql
SELECT r18.aor_id, count(DISTINCT r15.id) FROM echo_analytics.sigint_inbox_item r14 ALL INNER JOIN echo_analytics.signal_message r15 ON (((r14.id = r15.id))) ALL LEFT JOIN echo_analytics.sigint_post r16 ON (((r14.post_id = r16.id))) ALL INNER JOIN echo_analytics.signal_message_group r17 ON (((r14.id = r17.signal_message_id))) ALL INNER JOIN echo_analytics_derived.message_aor_link_v1 r18 ON (((r14.id = r18.sigint_inbox_item_id))) ALL INNER JOIN echo_analytics.area_of_responsibility r19 ON (((r18.aor_id = r19.id))) WHERE ((NOT r19.deleted)) AND (r19.is_top_level) AND ((r18.sigint_inbox_item_id >= ?)) AND ((r17.signal_message_id >= ?)) AND ((r17.group_master_key IN (?..))) AND ((NOT r15.deleted)) AND ((r15.id >= ?)) AND ((r14.datetime >= cast(? as DateTime64(?..)))) AND ((r14.datetime < cast(? as DateTime64(?..)))) AND ((r14.id >= ?)) GROUP BY r18.aor_id
~~~

Sample metrics: read_rows=6431451, tracked memory_usage=14822215231 bytes, thread IDs over query lifetime=338. Missing settings-map values do not independently prove inherited limits; gateway defaults were inspected separately.

Plain EXPLAIN PLAN indexes=1 succeeded. Date literals and numeric message lower bounds are redacted. The source relations, branch structure, index/granule evidence, and stage order are retained.

~~~text
Expression ((Project names + Projection))
  Aggregating
    Expression
      Join (JOIN FillRightFirst)
        Expression (Left Pre Join Actions)
          Expression
            Join (JOIN FillRightFirst)
              Expression
                Join (JOIN FillRightFirst)
                  Expression
                    Join (JOIN FillRightFirst)
                      Expression
                        Join (JOIN FillRightFirst)
                          Filter
                            ReadFromMergeTree (echo_cdc.sigint_inbox_item)
                            Indexes:
                              PrimaryKey
                                Keys:
                                  id
                                Condition: and((id in [[message_lower_bound], +Inf)), and((id in [[message_lower_bound], +Inf)), and((id in [[message_lower_bound], +Inf)), (id in [[message_lower_bound], +Inf)))))
                                Parts: 7/11
                                Granules: 168/5982
                                Search Algorithm: binary search
                              Skip
                                Name: echo_datetime_minmax_v1
                                Description: minmax GRANULARITY 1
                                Condition: and((datetime in (-Inf, \'[redacted]')), (datetime in [\'[redacted]', +Inf)))
                                Parts: 7/7
                                Granules: 168/168
                              PrimaryKeyExpand
                                Description: Selects all granules that intersect by PK values with the previous skip indexes selection
                                Parts: 7/7
                                Granules: 168/168
                              Ranges: 7
                          Expression
                            BuildRuntimeFilter (Build runtime join filter on __table5.sigint_inbox_item_id)
                              Union
                                CreatingSets (Create sets before main query execution)
                                  Expression
                                    Join (JOIN FillRightFirst)
                                      Filter
                                        ReadFromMergeTree (echo_cdc.signal_message_group)
                                        Indexes:
                                          PrimaryKey
                                            Condition: true
                                            Parts: 14/14
                                            Granules: 6822/6822
                                          Skip
                                            Name: echo_signal_message_id_minmax_v1
                                            Description: minmax GRANULARITY 1
                                            Condition: and((signal_message_id in [[message_lower_bound], +Inf)), and((signal_message_id in [[message_lower_bound], +Inf)), (signal_message_id in [[message_lower_bound], +Inf))))
                                            Parts: 9/14
                                            Granules: 213/6822
                                          PrimaryKeyExpand
                                            Description: Selects all granules that intersect by PK values with the previous skip indexes selection
                                            Parts: 9/9
                                            Granules: 214/213
                                          Ranges: 9
                                      Expression
                                        BuildRuntimeFilter (Build runtime join filter on __table4.master_key)
                                          Expression
                                            Join (JOIN FillRightFirst)
                                              Filter
                                                ReadFromMergeTree (echo_cdc.signal_group_aor)
                                                Indexes:
                                                  PrimaryKey
                                                    Condition: true
                                                    Parts: 2/2
                                                    Granules: 2/2
                                                  Ranges: 2
                                              Expression
                                                BuildRuntimeFilter (Build runtime join filter on __table5.id)
                                                  Filter
                                                    ReadFromMergeTree (echo_cdc.area_of_responsibility)
                                                    Indexes:
                                                      PrimaryKey
                                                        Condition: true
                                                        Parts: 1/1
                                                        Granules: 1/1
                                                      Ranges: 1
                                  CreatingSet (Create set for subquery)
                                    Expression (Project names)
                                      Distinct (DISTINCT)
                                        Distinct (Preliminary DISTINCT)
                                          Expression ((Projection + (Change column names to column identifiers + (Convert VIEW subquery result to VIEW table structure + (Materialize constants after VIEW subquery + (Project names + (Projection + (Change column names to column identifiers + (Project names + Projection)))))))))
                                            Filter ((WHERE + Change column names to column identifiers))
                                              ReadFromMergeTree (echo_cdc.sigint_zone_datasource)
                                              Indexes:
                                                PrimaryKey
                                                  Condition: true
                                                  Parts: 1/1
                                                  Granules: 1/1
                                                Ranges: 1
                                Expression
                                  Join (JOIN FillRightFirst)
                                    Filter
                                      ReadFromMergeTree (echo_analytics_derived.sigint_inbox_item_network_by_message_v1)
                                      Indexes:
                                        PrimaryKey
                                          Keys:
                                            sigint_inbox_item_id
                                          Condition: and((sigint_inbox_item_id in [[message_lower_bound], +Inf)), and((sigint_inbox_item_id in [[message_lower_bound], +Inf)), (sigint_inbox_item_id in [[message_lower_bound], +Inf))))
                                          Parts: 10/13
                                          Granules: 175/12133
                                          Search Algorithm: binary search
                                        Ranges: 10
                                    Expression
                                      BuildRuntimeFilter (Build runtime join filter on __table10.id)
                                        Expression
                                          Join (JOIN FillRightFirst)
                                            Expression (Left Pre Join Actions)
                                              Filter
                                                ReadFromMergeTree (echo_cdc.sigint_network)
                                                Indexes:
                                                  PrimaryKey
                                                    Condition: true
                                                    Parts: 1/1
                                                    Granules: 1/1
                                                  Ranges: 1
                                            Expression
                                              BuildRuntimeFilter (Build runtime join filter on __table11.network_id)
                                                Expression
                                                  Join (JOIN FillRightFirst)
                                                    Filter
                                                      ReadFromMergeTree (echo_cdc.sigint_network_aor)
                                                      Indexes:
                                                        PrimaryKey
                                                          Condition: true
                                                          Parts: 2/2
                                                          Granules: 2/2
                                                        Ranges: 2
                                                    Expression
                                                      BuildRuntimeFilter (Build runtime join filter on __table12.id)
                                                        Filter
                                                          ReadFromMergeTree (echo_cdc.area_of_responsibility)
                                                          Indexes:
                                                            PrimaryKey
                                                              Condition: true
                                                              Parts: 1/1
                                                              Granules: 1/1
                                                            Ranges: 1
                      Expression
                        BuildRuntimeFilter (Build runtime join filter on __table4.signal_message_id)
                          Filter
                            ReadFromMergeTree (echo_cdc.signal_message_group)
                            Indexes:
                              PrimaryKey
                                Condition: true
                                Parts: 14/14
                                Granules: 6822/6822
                              Skip
                                Name: echo_signal_message_id_minmax_v1
                                Description: minmax GRANULARITY 1
                                Condition: and((signal_message_id in [[message_lower_bound], +Inf)), and((signal_message_id in [[message_lower_bound], +Inf)), (signal_message_id in [[message_lower_bound], +Inf))))
                                Parts: 9/14
                                Granules: 213/6822
                              PrimaryKeyExpand
                                Description: Selects all granules that intersect by PK values with the previous skip indexes selection
                                Parts: 9/9
                                Granules: 214/213
                              Ranges: 9
                  Expression
                    Filter ((WHERE + Change column names to column identifiers))
                      ReadFromMergeTree (echo_cdc.sigint_post)
                      Indexes:
                        PrimaryKey
                          Condition: true
                          Parts: 2/2
                          Granules: 2/2
                        Ranges: 2
              Expression (Right Pre Join Actions)
                BuildRuntimeFilter (Build runtime join filter on __table2.id)
                  Filter (((WHERE + (Change column names to column identifiers + (Convert VIEW subquery result to VIEW table structure + (Materialize constants after VIEW subquery + (Project names + (Projection + (Change column names to column identifiers + (Project names + Projection)))))))) + (WHERE + Change column names to column identifiers)))
                    ReadFromMergeTree (echo_cdc.signal_message)
                    Indexes:
                      PrimaryKey
                        Keys:
                          id
                        Condition: and((id in [[message_lower_bound], +Inf)), and((id in [[message_lower_bound], +Inf)), and((id in [[message_lower_bound], +Inf)), (id in [[message_lower_bound], +Inf)))))
                        Parts: 10/13
                        Granules: 239/4667
                        Search Algorithm: generic exclusion search
                      Ranges: 10
        Expression (Right Pre Join Actions)
          BuildRuntimeFilter (Build runtime join filter on __table6.id)
            Expression (((WHERE + (Change column names to column identifiers + (Convert VIEW subquery result to VIEW table structure + (Materialize constants after VIEW subquery + (Project names + (Projection + (Change column names to column identifiers + (Project names + Projection)))))))) + (WHERE + Change column names to column identifiers)))
              Filter ((((WHERE + (Change column names to column identifiers + (Convert VIEW subquery result to VIEW table structure + (Materialize constants after VIEW subquery + (Project names + (Projection + (Change column names to column identifiers + (Project names + Projection)))))))) + (WHERE + Change column names to column identifiers)))[split])
                ReadFromMergeTree (echo_cdc.area_of_responsibility)
                Indexes:
                  PrimaryKey
                    Condition: true
                    Parts: 1/1
                    Granules: 1/1
                  Ranges: 1

~~~

## Appendix F: duplicate-link lookup plan

Normalized predicate from pg_stat_statements:

~~~sql
SELECT id, signal_message_id, signal_message_uuid, group_master_key, sender,
       login_id, message_uid, datasource_group_id, created_at
FROM signal_message_group
WHERE signal_message_id <> $1 AND created_at = $2
  AND datasource_group_id = $3 AND sender = $4;
~~~

Follow-up plain EXPLAIN used a narrower projection and synthetic values (ID/group 0, midnight date, placeholder sender). Both planned two workers and a parallel sequential scan with estimated one resulting row:

~~~text
Pivnich: Gather (cost=1000.00..874473.28 rows=1 width=16)
  Workers Planned: 2
  Parallel Seq Scan on signal_message_group (cost=0.00..873473.18 rows=1 width=16)
Skhid: Gather (cost=1000.00..1206556.43 rows=1 width=16)
  Workers Planned: 2
  Parallel Seq Scan on signal_message_group (cost=0.00..1205556.33 rows=1 width=16)
~~~

The matching equality index is absent on both. Real-parameter actual plans on a restored database remain necessary before choosing index order, projection, and rollout.
