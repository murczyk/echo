# Pivnich after the polling fixes (#3780)

Read-only investigation on **2026-10-13**, following
[iteration 3](../iteration3/findings.md). All times are UTC.
Production settings, services, workers, and data were not changed.

## Result and deployed release

Request pressure improved substantially. Compared with the five minutes just
before deployment, long polls fell 51%, filtered-ID lookups 52%, and message
hydration 56%. The reduction persists in two later windows. Counts improved
less: initially 12%, reaching 23% in the later sample. Duty remains the largest
source of count requests; frequent identical requests have not disappeared.

Package `0.1.1~rc.202610131240-1` was installed at 14:00:15. The API started at
14:00:52 and the background worker at 14:01:27. The served version is
`1.0.eec468a0d0f (13.Oct 12:18)`, containing fixes `20847ff1c` and `656e98f00`.
Its source has a 2,000 ms minimum ordinary long-poll response window, a
30,000 ms Analysis system-count interval, and a 2,000 ms Analysis reconciliation
interval. Classic Analysis's private poll loop is removed. This confirms the
served release; already-open tabs can continue running older JavaScript.

## HTTP measurements

[Sanitized measurements](measurements.json) retain the observations.
Every HTTP query restricts the shared GreptimeDB data to
`echo-pivnich.hyakutake-chromatic.ts.net` or `pivnich.echoua.info`.
Totals use `COUNT(DISTINCT request_id)` across lifecycle records. View attribution
uses request records only, with the referer selecting classic/Neo Analysis/Duty.
Lifecycle totals can include responses to requests started outside the window,
so they differ slightly from request-only view totals.

| Endpoint | Before 13:45–13:50 | After 14:05–14:10 | Change | Later 14:20–14:25 |
| --- | ---: | ---: | ---: | ---: |
| long-poll | 88,360 | 43,124 | −51.2% | 40,464 |
| get-inbox-count | 16,377 | 14,474 | −11.6% | 12,621 |
| messages-by-id-matching-filters | 2,051 | 987 | −51.9% | 993 |
| messages-by-id | 2,721 | 1,202 | −55.8% | 1,221 |
| comments-batch | 20 | 50 | +150.0% | 67 |

The five endpoints total 109,529 requests before, 59,837 immediately after
(−45.4%), and 55,366 later (−49.5%). The independent 14:10–14:15 window has
41,070 long polls, 13,955 counts, 958 filtered-ID lookups, and 1,202 hydration
requests. Comment volume is small and increased in this comparison.

| Endpoint | Median before → after, ms | p95 before → after, ms | p99 before → after, ms |
| --- | ---: | ---: | ---: |
| long-poll | 512 → 2,009 | 3,804 → 3,759 | 4,763 → 5,002 |
| get-inbox-count | 10 → 10 | 480 → 411 | 1,538 → 1,334 |
| messages-by-id-matching-filters | 36 → 34 | 109 → 77 | 178 → 114 |
| messages-by-id | 72 → 70 | 398 → 375 | 1,138 → 986 |
| comments-batch | 24 → 17 | 41 → 39 | 50 → 42 |

Percentiles are approximate and cover 13:45–13:50 versus 14:05–14:10 responses.
The minimum long-poll time rose from 501 to 2,001 ms, confirming server pacing.
Its longer median is the configured event accumulation delay. These are HTTP
timings, not end-to-end message freshness measurements.

No HTTP statuses at least 400 were retained for these endpoints in the first
three windows. The 14:20–14:25 window contains one `messages-by-id` HTTP 500
at 14:21:32, taking 1,070 ms. Its cause was not established.

## Duty: improvement from the original high-volume sample

The original [October 12 investigation](../iteration2/findings.md#production-request-evidence)
retains a five-minute count-like page-activity sample around 14:11. The same
classifier (`nolimit=true`, with heartbeat/page visits excluded) gives:

| View | Original records / accounts | Today 14:05–14:10 | Today 14:20–14:25 | Original → later |
| --- | ---: | ---: | ---: | ---: |
| Classic Duty | 10,763 / 13 | 7,020 / 11 | 5,640 / 11 | −47.6% |
| Duty Neo | 8,035 / 36 | 6,302 / 38 | 5,898 / 34 | −26.6% |

Together, Duty's count-like records fell from 18,798 to 11,538 (−38.6%). These
are comparable activity records, which can include unlimited message fetches,
not exact count-endpoint totals. Account counts changed, and feeds/tabs/filters
are not controlled. The other original five-minute sample (8,788 classic and
8,300 Neo) likewise shows a reduction, but smaller for classic Duty.

Iteration 1's 3,682 Pivnich analytics Duty-count log events over 07:18–07:23:18
measure a backend route boundary. They cannot be compared directly with browser
HTTP totals: caching and routing can change the number of backend executions.

The precise HTTP comparison around today's deployment is:

| View / endpoint | Before 13:45–13:50 | After 14:05–14:10 | Later 14:20–14:25 |
| --- | ---: | ---: | ---: |
| Classic Duty / long-poll | 8,642 | 3,773 | 3,945 |
| Classic Duty / get-inbox-count | 8,226 | 6,418 | 4,860 |
| Classic Duty / messages-by-id | 2,091 | 862 | 883 |
| Duty Neo / long-poll | 9,510 | 4,520 | 4,165 |
| Duty Neo / get-inbox-count | 6,203 | 6,273 | 5,869 |
| Duty Neo / messages-by-id | 127 | 71 | 75 |

Duty accounts for 12,691 of 14,450 request-only counts immediately after
deployment (87.8%) and 10,729 of 12,604 later (85.1%). Neo counts initially
remain effectively unchanged despite the lower long-poll rate. The active
stored Duty polling setting is five seconds, last updated at 08:10:27.

Repeated identical activity records were grouped by account and canonical JSON
payload, following the original method. This groups multiple feeds/tabs and
does not identify one browser's polling cadence:

| Repeat interval measure | Original October 12, three minutes | Today before, five minutes | Today later, five minutes |
| --- | ---: | ---: | ---: |
| Classic Duty repeats under 1 s | 6,007 | 7,669 | 4,497 |
| Classic share of repeat intervals under 1 s | Not retained | 87.6% | 80.8% |
| Duty Neo repeats under 4 s | 2,915 | 2,587 | 2,663 |
| Neo share of repeat intervals under 4 s | 59.5% | 44.2% | 47.7% |

Raw repeat totals span different durations. The original three-minute cadence
sample and five-minute volume sample are separate observations. Duty is better,
but a large recurring workload and rapid duplicate traffic remain. Reload
existing Duty tabs before judging adoption of the deployed frontend; if traffic
persists, identify tabs, feed counts, frontend versions, and count triggers.

## Analysis adoption and remaining database work

Classic Analysis long polls fell from 56,108 to 26,909 immediately after
deployment, but still constitute 62.9% of all request-only long polls. Neo long
polls fell from 2,816 to 1,253, and Neo counts from 682 to 562.

Four stable referer/browser groups account for 416 of those 562 Neo counts
(74.0%). Their count starts are five to six seconds apart, while their long
polls and filtered-ID lookups approximately halved. Two groups appearing after
deployment show 30–31 second count spacing. In the later window, four stable
groups still contribute 410 of 520 counts (78.8%) at the shorter cadence, while
three other groups show 30–31 second spacing. This is consistent with partial
frontend adoption and older tabs. Referer/browser groups can contain multiple
tabs; telemetry does not prove their loaded release or count trigger.

At 14:19:50, the Redis session registry held 125 sessions. Three sampled streams
each retained 1,000 inbox-change events over about 297.23 seconds: **201.9
events/minute**, versus iteration 3's 213.0. Each contained 353 unique message
IDs, 647 repeat events, and 1,000 null origins. The streams repeat the same
broadcast workload and must not be summed. Repeated IDs do not establish no-op
writes. The telemetry buffer held 122 members, below its 10,000-member cap at
that instant. Broadcast volume remains similar despite lower lookup traffic.

A separate 89.279-second source PostgreSQL snapshot ending at 14:23:36 compares
top-level statements, keyed by database user, query ID, and top-level flag, with
no statistics reset. A search-count shape completed four calls averaging
**16.2 seconds**, accumulating 64.9 execution seconds. Two network-activity
recalculation shapes averaged 19.6 seconds over two calls and 7.0 seconds over
four calls. These query costs remain material; they are not attributed to Duty
or measured as pre/post improvements. Accumulated SQL execution time includes
concurrent work and is not CPU usage.

## Resolution and next checks

The rollout improved request pressure, but the count problem is only partly
resolved. In the latest window, long polls fell 54%, filtered-ID lookups 52%,
and message hydration 55% compared with just before deployment. Classic Duty's
count-like activity fell 48% and Duty Neo's 27% compared with the original
October 12 sample, with slightly fewer active accounts. Duty still produces
85% of count requests, and 81% of identical classic Duty repeat intervals are
under one second. These aggregate repeats do not establish a single tab's
cadence.

Reload older Duty and Analysis tabs, then repeat host-scoped measurements with
client-version/tab attribution. Duty's remaining count volume deserves a
separate per-feed investigation; preserve discovery, unread counts, and
notifications when considering a longer interval. Expensive search counts and
network recalculation also need query-specific work.

The API and background worker were running, with no failed systemd services.
There is no matched pre-deployment CPU baseline, so reduced HTTP traffic does
not establish the same reduction in CPU or database cost. The windows are
observational, not controlled benchmarks. Historical journal retention did not
cover the comparison windows sufficiently for a slow-log comparison. This
investigation did not test browser-visible updates or notification latency.
