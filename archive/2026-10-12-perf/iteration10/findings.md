# Skhid verification after source-search fixes (#3780)

Read-only inspection on **25 October 2026**, through **23:36 UTC**. Skhid is
running `0.1.1~rc.202610252223-1`. The API started at **23:20:20 UTC**, and the
background/report workers at **23:20:57**; all three had zero restarts.
Pivnich was not inspected or changed during this verification.

**Verdict: partial improvement; #3780 remains open.** Counts and attachment
fallbacks improved in the sampled traffic, and ingestion remained current.
Long page requests and a native per-query memory failure remain. The new
literal-search index is ready, but its production workload was not exercised.

## Comparable observation windows

The equal 15-minute windows are **22:20–22:35 before deployment** and
**23:21–23:36 afterward**. HTTP records include the public, Tailscale and
direct-IP API hostnames, select response events, and deduplicate by request ID.
Intentional long polls are excluded from interactive latency conclusions.
Traffic, filters, cache state and concurrency were uncontrolled; the
differences below do not establish causality or peak capacity.

| Measurement | Before | After |
| --- | ---: | ---: |
| Retained HTTP responses | 52,877 | 54,430 |
| HTTP 5xx / 503 | 0 / 0 | 0 / 0 |
| Inbox count requests | 8,701 | 8,120 |
| Inbox count p95 / maximum | 2,022 / 10,188 ms | 560 / 5,166 ms |
| Inbox counts above two seconds | 449 | 134 |
| Inbox page requests | 1,082 | 1,102 |
| Inbox page p95 / maximum | 1,186 / 6,379 ms | 2,917 / 13,498 ms |
| Inbox pages above two seconds | 25 | 78 |
| Successful initial native gateway queries | 5,065 | 5,534 |
| Successful native query p95 / maximum | 2,052 / 3,586 ms | 1,410 / 10,355 ms |
| Native gateway query memory failures | 0 | 1 |

Source attachment-guard count completions fell from 38 requests with a
7,939-ms p95 to 12 with a 214-ms p95. All 12 post-deployment guard diagnostics
were `recent_message_change`, with historical coverage still complete.
These guards remain necessary for correctness. In the initial journal capture,
745 hybrid pages had a source-tail p95 of 61 ms and a maximum of 829 ms;
the worst page latency was predominantly outside that fresh-tail step.

Facet traffic changed materially: for example, tag requests increased from
14 to 68. Tag p95 fell from 7,798 to 3,119 ms, while group-count p95 increased
from 2,654 to 3,108 ms. Small, mixed-filter facet samples do not support a
general claim that every facet is now faster. Per-route measurements are in
[measurements.json](measurements.json).

## Remaining page and memory costs

At **23:26:50**, one native timestamp-cursor page hit the existing **2.2-GiB
per-query cap** while building a join: the attempted allocation would have
raised usage to 2.38 GiB. This was a query-limit failure, not total-server
memory exhaustion. The application recorded resource-limit fallback; no
HTTP 5xx, shared-circuit fallback, source statement timeout, deadlock, lock
timeout or idle-transaction termination appeared in the post-deployment window.

The failed native shape contained repeated group-access semi joins. The
slowest successful shape also had sender predicates and took **10,355 ms**,
tracking **2,185,572,415 bytes** and reading **183,558,258 raw versioned rows**.
Neither was a text-search query. These row and memory measurements do not
represent physical disk I/O or current logical message counts.

Source creation-time ID-bound queries also reached **6,137 ms** early after
startup. A later 201-second source-statistics delta contained 469 calls at a
24.17-ms mean. A plain representative plan used the existing
`signal_message_created_at_id_idx` index; no expensive actual plan was rerun.
The statistics reset and deallocation counters stayed unchanged. The same
delta still showed significant source batch-read and attachment-claim work;
lower native p95 does not establish that PostgreSQL cost has been eliminated.

## Index readiness and deployment interruption

Migration `m20261025_180900_inbox_body_literal_index` is recorded as applied.
The expected GIN trigram index is valid and ready, occupies **6,909 MiB**, and
has expression statistics. The source table's manual `ANALYZE` finished at
**23:20:18 UTC**. There was no remaining index build.

The index still had **zero recorded scans at 23:36**. Consequently this
inspection does not validate the production Exact/Substring speedup, common
versus rare pattern behavior, attachment-array memory, or the full prepared
source/analytics correctness matrix. Operator-session `SHOW plan_cache_mode`
does not establish the setting on application-owned connections. Source
planning-time tracking was disabled, so planning CPU was not measured.

Nginx recorded upstream connection failures from **22:38:28 to 23:20:20 UTC**,
about **42 minutes**, with 62,578 error-log entries. These are upstream
connection attempts, not unique HTTP requests. Application response telemetry
is absent during the interruption and cannot count its user-visible errors.
The interruption spans the deployment and ends just after migration analysis;
the entire interval was not independently attributed to index construction.
Account for this observed interruption before the later Pivnich rollout.

## Ingestion, summaries and configuration

Repeated samples found an active-source queue of 7, 2, 2 and finally zero rows,
with no retained retries and sampled oldest ages at most four seconds.
The 389 historical rows belonging to a deleted source are excluded. One
first-attempt deletion reconciliation failed with a zero-row update and left
the queue on a normal retry. Its source snapshot and persisted message were
both deleted, so queue disappearance is consistent with a deletion rather
than evidence of a new active import.

Six messenger retry errors and six lock-timeout mentions occurred in the
baseline window; afterward there was the one zero-row deletion retry and no
lock-timeout mentions. Seven media-summary worker errors in the baseline
became zero afterward, with two explicit superseded attempts observed.
Completed summary rows increased from 19,431 to 19,444 during inspection;
the final sample had no unfinished legacy summary jobs.

Existing analytics health metadata was repeatedly healthy and fresh, attachment
history was complete, the gateway-limit check passed, and the source slot
remained active. Sampled unconsumed WAL ranged from 163,144 to 3,240,672 bytes.
No heartbeat or health-writing script was run.

Configuration/data warnings remain: **82 groups and two networks** lacked AOR
assignments, and a consistency pass reported **126 mismatches among 110,907
checked networks**. These findings were not repaired.

No remote application, schema, data, configuration, service, retry state or
health metadata was changed. Continue the
[production verification checklist](../../../docs/performance/3780-verification.md)
for literal-search workloads, later pages, peak load and the next day;
this 15-minute post-startup sample does not complete the longer canary.


## Follow-up through 23:43 UTC

The same package and service start times remained in place, with zero restarts.
The latest **23:28–23:43 UTC** HTTP window retained **55,145 responses** and
zero 5xx/503s. Inbox page p95 was **1,121 ms**, maximum **5,091 ms** (953
requests); count p95 was **917 ms**, maximum **6,049 ms** (8,307 requests).
This window overlaps the earlier 15-minute sample by eight minutes.

A separate comparison of nonoverlapping **23:29–23:36** and **23:36–23:43**
windows found page p95 **1,267 → 1,121 ms**, maximum **5,091 → 3,377 ms**;
count p95 **625 → 1,023 ms**, maximum **3,244 → 6,049 ms**. Traffic and filters
were uncontrolled. The later window had zero HTTP 5xx, native exceptions,
source timeout/deadlock/lock-timeout mentions or messenger retry errors.
Native successful-query p95 was 1,484 ms, maximum 3,140 ms across 2,621 queries.

Health metadata remained fresh and healthy. At 23:43:54 the source slot was
active with 444,288 bytes of unconsumed WAL, and the active-source queue held
three new items, zero retries and a zero-second sampled oldest age. Legacy
summary completions reached 19,454 with no unfinished jobs. AOR warnings
persisted, and the literal index still had zero scans. Pages look steadier,
but counts still have a six-second tail and literal-search acceptance remains
open. See [follow-up measurements](followup-2343.json).
