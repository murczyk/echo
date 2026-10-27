# Remaining performance failures on Pivnich, Skhid and Siversk (#3780)

Read-only production investigation on **15 October 2026**, following
[iterations 1–4](../iteration4/findings.md). All times are UTC. See the
[fix plan](plan.md) and [sanitized measurements](measurements.json).
Application code, database schema/data, services and deployment settings were
not changed. SSH reused the existing unlocked agent.

## Result

The earlier polling, duplicate-lookup and search-detail fixes are deployed, but
several expensive paths and overload behaviors remain. The retained HTTP
responses from **12:30–15:25** contain **295 Pivnich, 242 Skhid and 113 Siversk
503s**. These are host-scoped, request-ID-deduplicated responses, not PostgreSQL
cancellation counts. Request starts can precede the response window.

| Evidence | Pivnich | Skhid | Siversk |
| --- | ---: | ---: | ---: |
| PostgreSQL statement timeouts, midnight–approximately 15:36 | 422 | 577 | 36 |
| PostgreSQL statement timeouts, 12:30–approximately 15:36 | 71 | 44 | 0 |
| ClickHouse memory exceptions, midnight–approximately 15:35 | 23 | 24 | 0 |
| ClickHouse memory exceptions, 12:30–approximately 15:41 | 2 | 6 | 0 |
| Largest retained HTTP 503 response duration, 12:30–15:25 | 475.9 s | 75.7 s | 15.7 s |

Siversk's 113 errors were independently confirmed as `fallback_saturated` in
its application journal, between 12:52:27 and 13:42:32. Its absence of source
statement timeouts and ClickHouse exceptions therefore does **not** establish
healthy request handling. PostgreSQL fallback admission can fail before SQL runs.

The 15:20–15:25 window is quieter: eight Skhid 503s and none on the other two
hosts. All eight Skhid failures have approximately 255–261 ms response times,
consistent with the observed 250 ms fallback admission deadline and eight
matching journal rejections. Earlier failures remain relevant to the rollout.

## Deployment and prior fixes

All three hosts serve `1.0.ad2678da257 (15.Oct 08:04)`, package
`0.1.1~rc.202610150805-1`. API start times were 12:21:47 on Pivnich, 12:12:50
on Skhid and 12:25:15 on Siversk. API, background and report services were
active with zero systemd restarts at the later inspection.

The deployed source includes the two-second ordinary event accumulation
window, two-second Analysis reconciliation interval and 30-second Analysis
automatic count interval. The duplicate-lookup, document-update and chunk-summary
indexes are ready and valid on every source. All three gateways report fresh
healthy replication and `history_complete=true` for attachments.

The current checkout is newer than this deployment. It includes the Exact and
Substring search modes and their direct source-body predicate/routing work.
Those changes must not be credited to the deployed release or assumed to fix
its quoted Fuzzy-search path. Network recalculation, network bounds, OCR and
GOI callsign logging code match the deployed commit; attachment coverage has
only the newer search-mode plumbing, with the same recent-change guard.

## Why requests still fail

### Facet fallback queues can wait for minutes

[`analysis/counts.rs`](../../../wdintel-rs/src/rer_importer/analysis/counts.rs)
keys its fallback mutex by source pool, login and serialized request. The key
does **not** include the facet operation. Messages, groups, frequencies and
other count endpoints for identical filters consequently share one serial
queue. This coordinates expensive work but does not share its results.

[`with_analytics_read_fallback_inner`](../../../wdintel-rs/src/rer_importer/analysis/mod.rs)
awaits that mutex without a deadline, before acquiring the fallback semaphore.
Its PostgreSQL timer starts afterward. A 30-second statement limit therefore
does not bound the HTTP lifetime, and existing route timings omit queue wait.
Requests routed by `query_policy` also bypass the fallback semaphore.

Pivnich's retained 503 responses reached 475,901 ms for message counts,
445,506 ms for group counts, 415,504 ms for frequency counts and 385,503 ms for
sender counts. The descending approximately 30-second steps and the shared
queue are strong evidence of serial waiting. Request-specific queue spans were
not recorded, so the entire duration cannot be assigned to the mutex alone.
These are backend response durations; a browser may abandon a request earlier.

Timeout handling is also inconsistent across endpoints. Pivnich has 16 HTTP
500s from `/api/sigint/freqs` at approximately 30 seconds; Skhid has one from
`/api/rer/analysis/callsigns-page` at 50 seconds. The callsign-page handler reads
the source directly without the analysis fallback/timeout mapping wrapper.
These timings suggest source timeouts, but the original error chains were not
retained for request-by-request confirmation.

### Attachment activity keeps text search on PostgreSQL

[`source_matches_incomplete_coverage`](../../../wdintel-rs/src/attachments/analytics.rs)
forces source fallback for every applicable text query when **any** attachment
document was updated in the last 90 seconds. The check is global: it does not
restrict the changed document to the request's groups, dates or search terms.
Filename changes, moves and deletions have a separate singleton guard.

At 15:37, the newest document updates were 1.6 seconds old on Pivnich,
2.7 seconds on Skhid and 33.3 seconds on Siversk. All satisfy that guard despite
completed historical replication. The sampled journals contain 39, 43 and 33
`attachment_history_incomplete` source routes respectively. That reason also
means recent changes; its name does not prove historical replication is missing.
Repeated history resnapshots would not remove this behavior.

This is a correctness safeguard, especially for removed terms, negative
predicates, moves and deletions. Removing it or shortening the freshness window
without a replacement can return wrong results. The observed recent updates
explain fallback at those instants; a continuous all-day fallback rate was not
measured.

### PostgreSQL search facets and tagged sender breakdowns remain expensive

Of Pivnich's 71 post-12:30 statement timeouts, 61 are text count/facet shapes,
seven are text inbox queries and three are other message count/facets. Repeated
examples use quoted/literal body and attachment predicates across separate
facets. Its PostgreSQL temporary-file logs record about **58.0 GiB** of file
sizes after 12:30, showing substantial spill activity; this is not peak disk
occupancy or a count of HTTP failures.

Skhid's 44 post-12:30 timeouts include **43 sender breakdown queries** using
AllTags predicates. The matching sender endpoint has 43 HTTP 503 responses,
averaging 75.5 seconds. SQL groups by sender, frequency, post and Kyiv date,
with a correlated tag-row `COUNT` and tag-access checks. Inspect
[`build_sender_breakdown_query`](../../../wdintel-rs/src/rer_importer/analysis/stats.rs)
and [`get_related_tag_items_filter`](../../../wdintel-rs/src/rer_importer/analysis/mod.rs).
Skhid also logged 43 client cancellations in ClickHouse after 12:30 for a
projected inbox read. Native SQL omits the sender/tag aggregation, consistent
with local gateway work; the full gateway plan still needs capture before a
specific pushdown rewrite is selected.

Siversk has no post-12:30 source timeouts, but 311 completed text count/facet
statements above its one-second log threshold accumulated 947.5 execution
seconds, with a 16.2-second maximum. Pivnich and Skhid log statements above
three seconds, so raw slow-log counts are not comparable across hosts.

### ClickHouse failures moved beyond the original AOR facet

Pivnich's two post-12:30 memory exceptions are an AOR-filtered inbox count and
candidate query at 13:09:13–13:09:14, with tracked peaks of **11.37 and
6.45 GiB**. Their fingerprints are `13164020871193851233` and
`3691299278516426647`. Both join access-group links and additional selected-AOR
group/network links. This is distinct from iteration 1's per-AOR facet query.

[`apply_resolved_analytics_aor_filter`](../../../wdintel-rs/src/rer_importer/inbox/query.rs)
adds two left joins followed by an OR membership check. Multiple memberships
can multiply intermediate rows before final distinct/grouping. A plain native
`EXPLAIN PLAN indexes=1` of the captured failing count confirms multiple
`FillRightFirst` joins and repeated group-link reads despite ID pruning. It
does not attribute the entire memory peak to a single join.

Skhid has six memory exceptions after 12:30. Small Duty queries with roughly
0.29 GiB tracked memory are among the victims. Successful candidate shapes
also reach 6.89 GiB in the post-rollout sample. A universal two-GiB cap would
therefore reject some currently successful supported requests.

All three default gateway sessions still use automatic 32 threads, unlimited
per-query/per-user memory and user concurrency, and no execution deadline.
The shared server memory ceiling remains 17.60 GiB. Fresh replication does not
protect query capacity. Skhid's analytics disk is 78% used, relevant when
considering spill strategies.

## Recurring work and warnings

Matched source statement snapshots cover approximately **115 seconds** from
15:33:16 to 15:35:11. Keys include user, database, query ID and top-level flag.
Reset timestamps are unchanged; Pivnich's deallocation counter increased by
one, so its matched-entry totals omit evicted/new work. Execution seconds sum
concurrent statements and are not CPU utilization.

| Work | Observed result |
| --- | --- |
| Pivnich network last-seen recalculation | Largest batch shape: three calls averaging 21.25 s and 4.36 GiB shared-block reads; 287 pending tasks at 15:37, oldest 53.6 minutes |
| Skhid network last-seen recalculation | Seven calls averaging 5.90 s; three recent queued tasks |
| Pivnich network-link ID bounds | Twelve calls averaging 2.60 s, 1.29 GiB shared-block reads |
| Siversk creation-time ID bounds | 127 calls averaging 297.6 ms, 37.8 execution seconds and 7.35 GiB shared-block reads |
| Skhid OCR global queue ranking | 33 calls averaging 586 ms, 19.3 execution seconds |

Network recalculation still has a five-minute statement allowance inside a
50-second run budget and uses `MAX(COALESCE(...))` over network history. Existing
creation-time covering and network/message composite indexes are present;
another generic index/cache is not yet justified.

A bounded Pivnich bounds diagnostic compared the existing min/max lookup with
per-network lateral endpoint seeks using eight common network IDs. Existing
SQL took 3.7 ms and the alternative 6.5 ms. The existing plan scanned the global
message-ID index and filtered network IDs; the alternative sought the composite
network/message index. This illustrates the access-path difference, not a
general speedup: sparse and absent networks, generic plans and actual slow
parameters must be tested before changing it.

The retained Pivnich journal covers only 15:25:21–15:33:40; Skhid and Siversk
cover approximately 15:18–15:33. These unequal windows contain 9,866 Pivnich
and 22,229 Skhid GOI callsign-sync INFO records. The code logs candidates,
selected rows and entire expected/existing workbook state individually.
Skhid also has 44,484 PostgreSQL text-search notices, chiefly empty/stop-word
tsqueries. Reduce repeated work and per-row diagnostics while preserving
search semantics and actionable failures.

Other warnings describe separate failures: Skhid has 110 expired/invalid OCR
grant warnings in its approximately 15-minute sample; GOI synchronization
reports remote server errors; settlement/unit diagnostics reject inconsistent
or ambiguous data. Skhid's post-12:30 lock timeouts include 12 settlement-link
updates, while Pivnich's 17 are advisory-lock requests. The battle-line update
path uses shared/exclusive advisory locks, but historical blockers were not
captured. These observations warrant targeted follow-up, not suppressing all
warnings or attributing them all to query overload.

## Polling and deployment failures

For known hostnames in 15:20–15:25, HTTP long polls/counts were 21,106/6,471 on
Pivnich, 19,304/8,609 on Skhid and 7,034/2,001 on Siversk. Request-only referers
identify Duty as 92.4%, 63.0% and 70.7% of counts respectively; unclassified
traffic remains. These are aggregate views/feeds/tabs, not individual tab rates.
The original iteration-2 request storm should not be assumed unchanged.

Nginx also records refused API connections during deployment:

| Host | Refused connections to port 8081 | Window |
| --- | ---: | --- |
| Pivnich | 10,872 | 12:19:20–12:21:47 |
| Skhid | 7,918 | 12:11:13–12:12:50 |
| Siversk | 3,640 | 12:23:31–12:25:15 |

The deployment recipe stops and masks the API socket/service before package
installation. The Redis maintenance marker cannot answer a proxy connection
when port 8081 is closed. These are upstream-connection failures, distinct from
application-generated database/fallback 503s. Nginx failures occurring before
the application do not appear in application HTTP telemetry.

Oversized upstream response-header errors also remain: 13 on Skhid and one on
Siversk today. Redirect/header diagnosis remains separate from search fixes.

No failing production query was replayed with `EXPLAIN ANALYZE`. Only the small
read-only bounds diagnostic executed, after plain plans, with a three-second
statement limit. Other native and PostgreSQL reads had defensive timeouts.
