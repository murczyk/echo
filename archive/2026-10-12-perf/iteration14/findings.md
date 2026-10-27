# Pivnich search failures before and after deployment (#3780)

Read-only investigation on `echo-pivnich` and its paired analytics host,
27 October 2026. Evidence covers the initial 10:17 UTC burst, the user's
10:24 deployment, and a recurrence at 10:55. Sanitized aggregates are in
[measurements.json](measurements.json); raw SQL, search text, access keys,
request IDs and logs remain private. No deployment or remote repair was performed
by this investigation. The [root work log](../../../wip.md) records the separate
local implementation and outstanding windowing work.

## Result

The deployment did **not** eliminate the failure modes. The first broad burst
ended before deployment, an initially quieter post-deployment interval still
contained network activity failures, and fallback saturation recurred on the
new package at 10:55 UTC.

There are three connected problems:

1. Valid attachment freshness checks send concurrent facet/page/count reads to
   PostgreSQL, where they occupy the shared eight-slot fallback limit. The first
   rejection happened with eight confirmed overlapping fallback executions.
2. Concurrent native queries can exceed the ClickHouse gateway user's aggregate
   memory budget even when individual queries stay below their own limits.
   These failures add PostgreSQL fallbacks and affect unrelated requests.
3. Network group activity also exceeds its individual native query memory limit.
   Its PostgreSQL fallback can then hit Pivnich's 30-second SQL timeout, returning
   a 503. Source attachment-search counts also still reach that timeout.

The first burst began with attachment-driven source saturation; shared-user
memory failures appeared about 44 seconds later. In the 10:55 recurrence,
shared-user memory failures preceded fallback rejections. Neither a universal
"ClickHouse caused every rejection" explanation nor a pure source-only
explanation fits both observations.

## What was deployed

At 10:22 UTC, the installed package was `0.1.1~rc.202610252223-1`; API and worker
services had been running since October 25 at 23:37 UTC. After the user's
deployment, the package was `0.1.1~rc.202610261229-1`, with the API started at
**10:24:21 UTC** and the worker at **10:24:46 UTC**. Both were active with zero
automatic restarts when inspected.

This package predates the uncommitted changes in this workspace. The running
binary lacked the new scoped-search, source-admission and count-queue markers.
Consequently this observation does not validate the locally prepared fairness,
cancellation or Fuzzy query changes from
[iteration 12](../iteration12/implementation.md).

Pivnich's configured source statement timeout is **30,000 ms**, lock timeout
3,000 ms and analytics query timeout 30,000 ms. Its analytics freshness budget
is 90,000 ms and retry cooldown 30,000 ms. Skhid's inspected source statement
timeout was 50,000 ms; do not assume both environments have identical budgets.

## HTTP observations

These are completed response events for Analysis routes, inbox routes beginning
`/api/rer-importer/get-inbox`, and network group activity summary. Host matching
includes Pivnich's public, SSH/Tailscale and IP-based request hostnames.
The restart transition is excluded from the equal nine-minute comparison.

| UTC interval on October 27 | Retained responses | Retained 503s | Affected paths |
| --- | ---: | ---: | --- |
| 10:15–10:24, old package | 8,745 | 70 | 66 inbox/Analysis; 4 network activity |
| 10:25–10:34, new package | 8,520 | 6 | All network activity |
| 10:42–10:47, new package | 4,804 | 1 | Frequency count |
| 10:54–10:57, new package | 3,062 | 11 | 7 inbox counts, 3 inbox pages, 1 groups facet |

No 500 response was present in these selected samples. The broad initial
search-error burst was confined to **10:17–10:18**, before the 10:24 restart.
The lower post-deployment error count is an observed interval difference, not
a controlled upgrade effect: filters, traffic, cache state and service restarts
were not held constant. The later recurrence rules out declaring recovery
from the first post-deployment sample alone.

Completion telemetry has a known deadline-recording gap in the deployed code.
A separate request-cohort join found three requests without a later retained
completion in the pre-deployment cohort and none in the first post-deployment
cohort. Their causes were not established; they are not silently counted as
successful responses or classified as deadline failures. Response and request
cohorts also differ at interval boundaries, so their totals need not match.

## Initial source saturation preceded shared memory failure

Retained application logs classified **71 ServiceUnavailable errors** in the
initial burst: **68 fallback-capacity rejections and 3 source SQL timeouts**.
The HTTP sample above excludes one user-group lookup outside the selected
paths, explaining 70 rather than 71 retained 503s.

At the first rejection, **10:17:00.619692 UTC**, completed source-route timing
records establish eight overlapping fallback executions: two sender facets,
three tag facets and three group facets. Their source durations were approximately
3.3–17.4 seconds. All eight recorded `attachment_history_incomplete` as the
fallback category; the detailed coverage guard reported `recent_message_change`.
The history-complete marker was already true. The category is therefore not
evidence that the historical snapshot was missing.

The first retained shared-user memory failure was at **10:17:44.133 UTC**.
Native query logs contain **96 distinct shared-user memory failures** and eight
individual-query memory failures during 10:14–10:24. Repeated stack lines and
coverage warnings are not additional native query failures. In particular,
the 417 application "analytics query failed" warnings must not be presented
as 417 ClickHouse failures; guards and cached routing decisions also use that
warning path.

Native counts cover all gateway queries, rather than just the selected HTTP
routes. Their initial interval begins a minute earlier than the HTTP comparison.
Query attempts, source fallback attempts and HTTP requests are separate counts.

Successful native queries in this interval individually peaked at about
1.08 GB. A frequent shared-limit victim used only about 43 MB itself. The
aggregate user's memory budget can therefore reject a small query because of
other work. The logs establish concurrent memory pressure, but do not identify
a single initiating native query or prove that all 32 allowed queries ran
simultaneously. Individual peak memory values cannot be summed into a measured
concurrent peak.

## Native limits and remaining network failure

The gateway user's effective settings were:

| Setting | Value |
| --- | ---: |
| Per-query memory | 2,362,232,012 bytes, about 2.20 GiB |
| Aggregate user memory | 9,448,928,051 bytes, about 8.80 GiB |
| Threads per query | 4 |
| Concurrent queries per user | 32 |

In 10:25–10:34, native logs recorded 6,838 successful queries, **six individual
query memory failures**, and no shared-user memory failure. All six failures
were the same normalized final network group activity aggregation, with six
joins over network links, inbox, messages, networks, datasource/group and
frequency data. A failed query read up to 56.35 million rows and approached the
2.20-GiB cap; the exception identified reading the inbox `freq` column.

Source PostgreSQL logs confirm **six network activity statement timeouts** in
that same interval, matching the six retained HTTP 503s. The native failure is
followed by an expensive source fallback, rather than a successful fallback
that merely records a native warning. Network responses took up to 36.620 s.
Further network source timeouts were retained at 10:36, 10:47, 10:50 and 10:51.

The failed post-deployment query is the **final aggregation**, not the earlier
unbounded `min(id), max(id)` period-bounds query. The current period-bounds
implementation already walks one-million-ID chunks and explicitly bounds both
inbox and message inputs. The final `NETWORK_GROUP_ACTIVITY_SQL` still applies
its explicit message-ID range to the network-link input; matching bounds are
not explicitly written on both joined inbox/message inputs. Its captured native
SQL does contain range constraints. A follow-up must inspect where those bounds
are pushed and how much each input reads; merely observing a bounded link does
not establish bounded memory for the whole join. No failing query was replayed.

Relevant code:

- [Final activity SQL and loader](../../../wdintel-rs/src/sigint/network/analytics.rs).
- [Fallback entry and PostgreSQL aggregation](../../../wdintel-rs/src/sigint/network/bl.rs).
- [Read-deadline route selection](../../../wdintel-rs/src/server/read_deadline.rs).

The network activity routes are absent from the local read-deadline allowlist,
and their source aggregation still calls `.all(db)` directly. The locally
prepared source-query admission/cancellation wrapper therefore does not
automatically cover this path. Fallback admission still applies, but this
coverage gap needs its own decision and regression before claiming the local
patch addresses the network failure.

## Recurrence and source count timeouts

The 10:42–10:47 HTTP sample contained a frequency-count 503 lasting 32.212 s.
PostgreSQL recorded its attachment-search count timeout at 10:46:16.296 UTC,
with additional attachment-count timeouts at 10:48:43, 10:52:14 and 10:53:59.
Retained application records classify the latter as frequency-count source
fallbacks after an attachment coverage guard, each spending 30,001 ms on source.
Thus the new deployment did not resolve the expensive source count problem
measured in [iteration 13](../iteration13/findings.md).

The frozen **10:54–10:57** native window contains **24 distinct shared-user
memory failures**, beginning at 10:55:13 UTC, alongside 2,179 successes.
The first fallback-capacity rejection followed at **10:55:41.696171 UTC**.
Application logs record 12 rejected fallback attempts: seven Duty counts,
three inbox candidate reads and two group-activity enrichments. These are
attempts, not 12 distinct failed HTTP requests: enrichment can be optional.
The selected response sample contains 11 actual 503s.

At least seven source fallbacks have confirmed overlapping timing intervals at
that first rejection: six attachment-guard fallbacks and one group-activity
enrichment after `analytics_resource_limit`. Another overlapping successful
analytics-route timing must not be counted as a source-slot occupant. This
recurrence directly demonstrates shared-memory failures and freshness-driven
source traffic competing for the same fallback capacity on the new package.

## Health and evidence limits

Existing analytics health rows were healthy at 10:31:13 and 10:38:57 UTC, with
current source heartbeat visibility and confirmed replication progress. The
attachment history marker was complete, with its stored start on October 15.
These observations do not establish health at the exact initial incident time
or waive request-scoped attachment guards. No resnapshot is justified by the
retained evidence.

Source journald retention was only minutes; later reads no longer contained the
first burst. Initial logs were saved before they disappeared. The final source
journal capture retained roughly 10:46:48–10:56:56. PostgreSQL's active collector
log supplied the earlier source timeout statements. Persistent ClickHouse query
logs supplied native counts. Missing journal history is not evidence that a
failure did not happen.

Diagnostics read service/package/configuration state, existing health/history
rows, activity events, active-query state, PostgreSQL logs and native query logs.
They did not execute application HTTP searches, replay expensive failure SQL,
refresh statistics, flush logs/caches, run health checks that write metadata,
restart services or change limits/data. Active source SQL was truncated by
`track_activity_query_size` and was not treated as a complete replayable query.

## Work to prepare next

- Inspect the final network aggregation's native/gateway plans and source
  fallback plan with representative parameters. Verify explicit bounds on
  every large input and measure a bounded aggregation strategy while preserving
  network/frequency validity, authorization, date, group and deduplication rules.
- Assess shared native admission as well as per-query limits. The observed
  aggregate-memory failures are not fixed by increasing the source timeout or
  simply increasing ClickHouse memory caps. Preserve correct fallback guards.
- Close the network-route source admission, cancellation and deadline coverage
  gap deliberately; verify that expensive fallbacks cannot monopolize capacity
  needed by inbox pages and counts.
- Continue the existing Exact-count/page strategy work. Calendar windows alone
  repeat global matching and have not established a safe count budget.
- Validate proposed changes locally and prepare a concrete rollout separately.
  The user requested findings first and deferred handling the outage case;
  no new outage fix or remote mutation is included here.
