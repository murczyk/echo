# Skhid 503 investigation after the October 26 deployment (#3780)

Read-only investigation on **26 October 2026**, following the
[morning investigation](../iteration11/findings.md) and
[bounded-query changes](../iteration11/implementation.md). Skhid runs
`0.1.1~rc.202610261229-1`; its API started at **12:47:41 UTC** and workers at
**12:48:06**, with zero restarts during inspection. No deployment, service,
configuration, schema, application data, retry, or analytics metadata was changed.
Sanitized evidence is in [measurements.json](measurements.json). Raw request
identifiers, referers, terms, access keys, coordinates and SQL remain private.
This is the pre-fix baseline; see the subsequently prepared
[local implementation and diagnostic limits](implementation.md).

## Corrected failure count

There were **143 confirmed HTTP 503 failures in 12:50–15:00 UTC**, rather than
the 102 found by counting retained response events alone:

| Return mechanism | Requests | Evidence |
| --- | ---: | --- |
| PostgreSQL statement timeout | 76 | SQLSTATE 57014 mapping and matching service-unavailable messages |
| Whole-request deadline | 41 | Explicit 60-second deadline events, service-unavailable messages and request events without a completion |
| Source fallback capacity rejection | 26 | `fallback_saturated` events and matching service-unavailable messages |

All 102 retained 503 response records had a retained request event. For the
41 deadline events, bounded searches around their expected start times found
55 request candidates: 14 had completions and 41 did not. Those 41 have the
corresponding paths and start times. The response window includes all three
Skhid hostnames and deduplicates by request ID.

The activity recorder is inside the HTTP deadline middleware in
[`server/mod.rs`](../../../wdintel-rs/src/server/mod.rs). At expiry, the outer
deadline drops the activity future before it records a response. This is an
observability defect: response-only telemetry misses these client-visible
failures. It also makes apparently error-free windows misleading. Simply
moving the recorder is insufficient: its `Err` branch currently hard-codes
500 instead of using the actual error response status. A repair must record
the real status exactly once, preserving the request ID for deadline errors.

The 707,688 retained response records are therefore not a complete denominator
for the actual failure rate. Native query errors and PostgreSQL errors must
not be added to these HTTP counts.

## Dominant cluster: broad Fuzzy search with excluded phrases

**94 of the 143 failures** have referers describing the same search family:
twelve positive OR terms and four excluded quoted phrases, across several
same-day periods. These comprise **67 statement-timeout responses and 27
deadline failures**, associated with four tab identifiers. Tab identifiers do
not prove four concurrent users. The executed PostgreSQL statement shapes
independently confirm the twelve positive terms and four negative predicates.
Referers describe UI context; the actual POST bodies are not captured.

The largest burst was around **13:55–14:02 UTC**. The affected endpoints were
inbox pages, group/sender/frequency/tag facets and several facet counts. Source
statement timeouts occurred at the configured **50,000 ms** deadline. These
queries use `route=postgres reason=query_policy`: quoted Fuzzy predicates are
deliberately unsupported on analytics. The new broad analytics page/count
chunking consequently does not optimize these reads.

[`attachments/search.rs`](../../../wdintel-rs/src/attachments/search.rs)
builds a separate body/filename/current-chunk match union for each positive
term, followed by the negative literal predicates. In this broad source scope,
[`search_uses_candidate_ids`](../../../wdintel-rs/src/rer_importer/analysis/mod.rs)
does not enable correlation: there is neither an analytics ID scope nor one
selected nonempty frequency. Each facet independently repeats this work.

A plain generic plan of the captured parameterized group query contained
**254 nodes, twelve body-search inputs, 32 media inputs and seventeen
aggregate/unique nodes**. Its global text-match inputs have no outer request
date/access restriction. This is evidence of the query structure, not a timed
execution or an estimate for the missing original bind values. PostgreSQL
logged **78 timed-out statements** with this complex-search shape; those are
SQL attempts, including work whose caller had already disappeared, rather
than 78 additional HTTP failures.

The next query work should address this captured broad OR/negative shape,
including repeated union deduplication and applying the eligible candidate
scope before expensive text work. Any union combination or candidate-first
rewrite needs production-scale evidence and result equivalence. Earlier
iterations already rejected a universal correlated rewrite; this investigation
does not revive it without measurements. Raising deadlines or moving these
unsupported predicates to analytics would not establish a correct fix.

## Why other searches were rejected

The **26 fast 503s** are source fallback admission failures, with a configured
limit of **eight concurrent operations** and a **250-ms admission wait**.
At **13:20:19.175346 UTC**, the first rejection in the main burst, eight
overlapping, successfully completed source-fallback execution intervals already
occupied all eight slots:

| Operation | Full execution interval length |
| --- | ---: |
| Frequency count | 27.320 s |
| Frequency facet | 27.321 s |
| Tag facet | 18.001 s |
| Group facet | 26.696 s |
| Sender facet | 26.769 s |
| Group count | 14.943 s |
| Another tag facet | 14.997 s |
| Unit facet | 47.017 s |

These all logged `reason=attachment_history_incomplete`. Coverage diagnostics
for this window recorded **1,089 `recent_message_change` decisions**, rather
than missing historical coverage. The guarded paths protect recent changes;
historical attachment coverage was complete and replication was fresh.
Resnapshotting history or removing the freshness guard is unsupported.

The rejected requests included a separate short text search with location/AOR
filters and other unit-filtered searches. Capacity pressure therefore affected
requests beyond the largest complex-search cluster. Query-policy source reads
bypass this fallback semaphore, so the eight-slot limit does not cap all the
expensive source work running concurrently.

Preserve the source protection while reducing the work that holds permits.
Any admission/fairness change needs useful-completion and latency measurements;
replacing long waits with faster rejections alone is not recovery.

## Why count requests reached sixty seconds

[`analysis/counts.rs`](../../../wdintel-rs/src/rer_importer/analysis/counts.rs)
still keys its source fallback mutex by pool, login and serialized request,
without the facet operation. Different count facets for identical filters
therefore wait in one serial queue without sharing results. This behavior and
its risks were documented in [iteration 5](../iteration5/findings.md#facet-fallback-queues-can-wait-for-minutes);
that stabilization deliberately preserved the coordination policy.

The source route timer starts after the queue wait, whereas the HTTP deadline
includes it. The complex-search burst contains groups of different count
endpoints expiring together at approximately 60 seconds. Across the whole
window, deadlines affected groups (9), senders (8), frequencies (8), posts (7),
units (3), locations (3), tags (2) and messages (1). The unchanged queue and
captured timing support head-of-line waiting; request-specific queue spans
are absent, so individual wait times cannot be assigned exactly.

The production database logged 89 statement timeouts while the application
mapped 76 into the corresponding HTTP errors. Ten client-loss events followed
failed complex-search statements. Together with the existing SQLx cancellation
investigation, this is consistent with submitted SQL outliving abandoned
callers. It does not provide an exact request-to-backend cancellation trace.
The HTTP deadline must not be treated as proof that database work stopped.

Count coordination needs a bounded, observable wait and a validated strategy
for avoiding repeated expensive work, preserving per-user authorization and
each facet's own-filter removal. Adding the operation to the key without a
source concurrency design would release a new fan-out and is not proposed as
a standalone fix.

## Separate Exact-search failures

Eight source timeouts used Exact regex predicates: **three inbox pages, three
tag facets and two network facets**. Their operation/completion times match
eight retained 503 responses. Six request referers explicitly selected Exact
mode; two page/tag referers still showed a default mode. This is a concrete
reason to distinguish referer context from the uncaptured POST payload. These
searches cover roughly six months, with short patterns, and are distinct from
the same-day Fuzzy cluster.

The captured inline source network query exposes a concrete missed path in
[`build_networks_query_for_login`](../../../wdintel-rs/src/rer_importer/analysis/stats.rs):
its messages CTE has an obligatory inbox join but calls the generic search
helper. The literal predicate consequently combines the inbox body with
`signal_message.id = ANY(attachment_ids)`. Its plain production plan starts
with parallel historical message/access-link scans and applies the body
predicate after primary-key inbox lookups. The existing literal GIN index is
valid; its existence does not make this query use it.

A read-only prototype changed only that membership key to the equal joined
`sigint_inbox_item.id`. The estimated total cost fell from **6,541,913.88 to
29,468.43**, and the plan used a bitmap OR containing the literal body GIN
index. **Both full-query probes still exceeded eight seconds.** Estimated
cost reduction is not a demonstrated latency improvement.

An isolated attachment-match subquery completed in **511.713 ms**, with 7,259
shared reads and no temporary writes. The isolated body predicate, even with
the GIN index planned, exceeded a separate **three-second** budget. It omitted
access checks to isolate index work and is not a whole-query correctness test.
The remaining broad body workload needs measurement alongside the missed
inbox-key path. No new index, statistics refresh or planner setting was applied.

## Remaining cases and native memory errors

Beyond the 94 complex-search failures and eight Exact source timeouts, the
remaining **41 HTTP failures** comprise 26 admission rejections, fourteen
deadlines and one source statement timeout. Their contexts include short
searches with units/locations/AORs and an inbox-map query with no search term,
seven units, six locations and nine groups. A plain plan of that captured map
query reads historical message/peleng/access relations before applying the
requested inbox date/location/unit predicates. It needs its own bounded
candidate-plan work; optimizing text search alone will not resolve it.

The three post-deployment native memory exceptions belong to **network group
activity** and hit the **2.2-GiB per-query limit**. All three corresponding
source fallbacks completed successfully. They are a separate query issue and
do not directly account for these 143 HTTP failures. No aggregate-user or
total-server memory failure was found in this post-deployment native window.

Failures continued in **15:00–15:30 UTC**: two retained capacity-rejection 503s
and two additional deadline events. The main 143-request classification uses
only 12:50–15:00. Source ingestion and replication were current in repeated
samples, without API/worker restarts; this is not evidence of a deployment
restart or sustained replication outage.

## Follow-up order and limits

1. Repair deadline activity recording and propagate bounded request/operation
   correlation through queue/admission/SQL stages. Validate the exact status
   and one completion per request, including errors.
2. Optimize the captured broad Fuzzy OR/negative source queries and measure
   source facet fan-out and queue lifetime. Preserve search, access, revision,
   date and own-facet-filter semantics; prove cancellation/pool reuse locally.
3. Address the Exact network helper's obligatory-inbox path together with
   broad body-search cost. The measured prototype is not ready to claim a fix.
4. Scope the independent map/peleng and native network group-activity joins.
   Validate combined traffic, useful completions, replication and source work
   before accepting another rollout.

No implementation or production repair was performed during this investigation.
Investigation queries were read-only, started with plain plans and used statement budgets of eight
seconds or less. Request bodies and request IDs inside SQL/route spans are
unavailable; exact filter reconstruction and per-request SQL attribution have
the limits stated above. A future implementation needs focused regressions,
production-scale plan evidence and the ordinary independently approved
deployment followed by [post-deployment verification](../../../docs/performance/3780-verification.md).
