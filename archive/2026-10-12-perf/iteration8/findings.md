# Skhid after bounded parsing and analytics ranges (#3780)

Read-only inspection on **25 October 2026**, after the user deployed package
`0.1.1~rc.202610251425-1`. The API started at **15:10:22 UTC**, the background
worker at **15:10:46**, and neither had restarted again during inspection.
No remote application, data, schema, configuration, services, retry state or
analytics health metadata was changed by the investigation.

## Observed improvement

The equal 15-minute windows are **14:45–15:00 before deployment** and
**15:12–15:27 afterward**. HTTP records are scoped to Skhid's public, Tailscale
and direct-IP hostnames, restricted to response events and deduplicated by
request ID. Intentional event-stream long polls are excluded from endpoint
latency conclusions. Filters, users, cache state and concurrency were not
controlled; these observations do not establish a capacity or latency SLA.

| Measurement | Before | After |
| --- | ---: | ---: |
| Retained HTTP responses | 57,415 | 62,159 |
| HTTP 5xx / 503 | 0 / 0 | 0 / 0 |
| Inbox page responses | 1,444 | 1,362 |
| Inbox page p95 | 1,930 ms | 1,260 ms |
| Inbox page maximum | 6,089 ms | 17,419 ms |
| Inbox count responses | 7,697 | 8,586 |
| Inbox count p95 | 2,277 ms | 2,074 ms |
| Inbox count maximum | 14,696 ms | 11,405 ms |
| Successful initial native gateway queries | 5,930 | 5,956 |
| Initial native gateway query memory failures, code 241 | 4 | 0 |
| Successful native query p95 | 2,040 ms | 2,039 ms |
| Largest successful native query tracked memory | 1.136 GiB | 1.079 GiB |

The four earlier failures hit the already deployed **2.2-GiB per-query cap**;
they are not a recurrence of the earlier total-server memory incident.
Post-deployment analytics successes remained in the same range, so the absence
of failures was not explained by routing all work to PostgreSQL. Successful
queries still read as many as **183.4 million versioned raw rows**; this is not
physical disk I/O or the number of current logical messages.

The gateway limit check passed: 2.2 GiB per query, 8.8 GiB per user, four
threads and 32 concurrent queries, with nonzero lower bounds and matching
upper constraints. Existing health metadata at **15:31:39 UTC** was healthy,
historical attachment coverage was complete, and the source replication slot
was active with sampled unconsumed WAL between 2,432 and 4,350,376 bytes.

## Messenger recovery

Two snapshots previously failing at **226 attempts** cleared on their normal
post-deployment retries. One produced an active inbox message at **15:26:58**;
the other produced a duplicate trace at **15:32:30**. Queue removal was checked
against persisted message state rather than assumed to prove an import.
The active-source queue subsequently held six items, approximately 3–5 seconds
old, with no retried items. The 389 legacy queue rows belonging to a deleted
source are excluded from this active-ingestion conclusion.

Through the final inspection there were no post-deployment deadlocks,
idle-in-transaction terminations, statement timeouts, circuit-open routing or
analytics resource-limit fallback mentions in the application/worker journal.
One messenger attempt hit a settlement-event lock timeout at **15:21:01**;
it was absent from the later retry queue. This isolated retry does not establish
that all import lock contention has been eliminated.

## Remaining work and verification

The 17.4-second inbox tail remains unexplained by aggregate native timings.
Attachment guards still deliberately route some searches to PostgreSQL even
with complete historical coverage; the route label alone does not identify
which freshness guard rejected the request. Broad quoted Fuzzy, Exact and
Substring queries remain source-routed by policy. The sampled traffic does
not prove that all broad unit/frequency/facet combinations are now bounded.

Follow the [production verification checklist](../../../docs/performance/3780-verification.md)
for matched windows, peak-load observation, result equivalence, replication
and ingestion checks. The [local fixes and investigation](implementation.md)
explain the freshness fallback reason and address recent-tail text work and
latest-page historical scans; those fixes have not been deployed by this work.
