# Live updates, counters, and search load

Merged investigation of `echo-skhid` and `echo-pivnich` on **2026-10-12**.
All observation times are UTC. The measurements below retain their original
windows; they are not a fresh production sample taken during this merge.

## Iteration 2 implementation scope

Issue: [#3780](https://github.com/echoua/echo/issues/3780). Implementation is
authorized on `3780-sys-events`, with `stable` merged before code changes.
Iteration 1 archive moves are preserved. No production changes are authorized
by this local implementation step.

- Analysis Neo: immediate user-query refreshes, with the existing typing
  debounce; system-event counts wait for five seconds since the last actual
  count start and for all requests in that cycle to settle. Keep one pending
  refresh, reject obsolete results, and bound stuck requests.
- Duty Neo: preserve the existing polling configuration and independent feed
  progress; remove event-triggered count polling, coalesce recovery with due
  automatic counts, prevent overlapping per-feed count cycles, and reuse
  identical unread/tail answers without combining different cursors.
- Classic Duty: honor the existing polling setting with a five-second minimum,
  and filter event IDs against loaded messages before hydration.
- Telemetry: preserve request and response records separately when they share
  a second and request ID. Retain the existing export format and deduplicate
  request IDs when measuring HTTP totals.
- AI-position worker: report whether completion applied changes, and suppress
  inbox broadcasts for verified stale-source/re-enqueued-job skips. Preserve
  notifications for committed updates. Add focused regression evidence for
  both skip paths; investigate other producers before suppressing anything else.

New Analysis settings, event-schema changes, broad worker-attribution
instrumentation, additional backend caching, and production rollout remain
deferred. The detailed investigation below describes the observed baseline;
implementation and validation results are recorded at the end of this file.

## Reviewed conclusion

Inbox-change broadcasts amplify background requests in **Analysis Neo and
Duty Neo**. Classic Analysis does not recount on these events. Classic Duty
adds a separate one-second polling loop and hydrates event IDs even when its
feeds do not display them.

Duty produces most of the sampled count-like HTTP traffic on both hosts.
Separately, Pivnich's search-bearing Analysis activity increased approximately
10.38 times over the comparable previous-day window, with browser evidence
confirming Neo for an inspected repeated search. These findings concern
different workloads and agree with each other. Request volume alone cannot
rank their database cost or establish the dominant cause of total server load.

The iteration 2 scope above is now authorized for implementation. Analysis
keeps user-driven counts immediate and starts a system-event recount only after
both five seconds since the last count start and completion of that count.
Duty request reductions and the verified telemetry/worker fixes are included.
New Analysis settings, broader event attribution, and production rollout remain
deferred.
Keep live message updates and Duty discovery, unread, and notifications.

Do not simply suppress recounts whenever an unseen changed ID currently fails
the filters: that message may have previously matched outside the loaded page.
Do not disable all Duty counts or attribute all broadcasts to the tag bot.
Neither an exact per-tab request total nor a single runaway worker has been
established.

## Scope and deployment evidence

- Host: `echo-pivnich`; SSH reported hostname `ct-echo-pivnich`.
- Deployed version file: `1.0.142f307e8d1 (10.Oct 16:50)`.
- Installed `wdintel-rs` package: `0.1.1~rc.202610101700-1`.
- Deployment was observed on October 11 around 11:27; server startup around
  11:29.
- Relevant notification and count-refresh code was checked against deployed
  commit `142f307e8d1a40938754e0d669050c3e4a1d917a`, rather than relying only on
  the newer local checkout.
- Production inspection used PostgreSQL, GreptimeDB activity, Redis streams,
  deployment metadata, and application logs. No production settings, services,
  workers, or data were changed.

SSH used the already unlocked agent from the existing tmux session. The
initial shell had no `SSH_AUTH_SOCK`; explicitly selecting that existing
agent with `IdentityAgent` and using `BatchMode=yes` established access without
reloading the encrypted key or changing the agent. Future inspection should
reuse the current unlocked agent rather than starting or replacing it.

Both hosts had API and background-worker services active and bot tags enabled.
At 13:48 UTC, one-minute load averages were 68.29 on Skhid and 65.24 on Pivnich.
These are container-visible load averages, not measurements of counter CPU use.
Skhid also ran package `0.1.1~rc.202610101700-1`.

The merge review rechecked count scheduling, event reconciliation, request
telemetry keys, and the AI-position notification opportunity against source.
The relevant Analysis count hook, middleware, and AI-position worker are
unchanged between the identified deployed commit and the pre-implementation
checkout `a3508a57b`. Analysis
reconciliation has newer network-hiding changes, but the inspected unseen-ID
recount condition is unchanged. This does not identify the frontend build of
every open tab; older tabs can continue running older logic.

## Live notification evidence

The Redis session registry contained 122 session IDs at inspection. `tandryk`
had one registered session; `alex2710` had no currently registered session at
the later inspection. A session count is not a browser-tab count, and an
earlier account's activity can remain in telemetry after its session ends.

A retained stream sample for `tandryk` contained **1,008 `ETInboxChanged`
events across 280.149 seconds**, approximately **216 events/minute**, or
3.6 events/second. This is a short live sample, not an all-day average.
Every sampled event had `origin = null`.

The same message ID often appeared several times:

| Message ID | Intake log time | Sample notification times |
| --- | --- | --- |
| `34358669` | 14:04:59 | 14:04:59.967, 14:05:00.249, 14:05:00.648, 14:05:02.971 |
| `34358675` | 14:04:59 | 14:05:00.673, 14:05:00.922, 14:05:01.307, 14:05:04.102 |
| `34358880` | 14:05:25, with another intake record around 14:05:27 | 14:05:25.295, 14:05:26.157, 14:05:26.706, 14:06:12.178, 14:06:13.500 |

This timing is consistent with intake, duplicate handling, and subsequent
enrichment of the same canonical message. It does not identify which writer
emitted each notification or prove that identical events represented identical
data states.

[event_stream::fanout](../../../wdintel-rs/src/event_stream/mod.rs) gets all registered
sessions and appends the event to each session's stream. That function does
not restrict delivery to the recipient's active search, time range, or
message access scope. The data-fetch endpoints still perform authorization;
global notification delivery does not mean that every recipient can fetch
the changed message.

[EventMsg](../../../wdintel-rs/src/event_stream/types.rs) carries an event ID, type,
timestamp, optional origin, and an intelligence-report flag. An
`ETInboxChanged` identifies a message, but has no worker name, update reason,
changed-field list, or previous filter membership. There is no literal
"frontend data updated" event in the inspected enum.

Notification emitters include message intake, Sigint processing, AI callsign,
settlement and position enrichment, tags, Palitra, OCR, and media summaries.
The available stream cannot rank those emitters by contribution.

Earlier, separate Redis samples contained approximately 274 inbox-change events
per minute on Skhid and 201 on Pivnich, with matching broadcast sequences across
multiple session streams. The later 216/minute Pivnich figure covers a different
window and session; it does not contradict those samples.

The [tag worker](../../../wdintel-rs/src/tags/worker.rs) broadcasts after committing
inserted tags. The inspected network invalidation/recalculation worker does not
emit these inbox-change broadcasts; network edits instead have an
`ETNetworkChanged` path that refreshes shared network reference data.
Managed-agent search calls and background AI enrichment are separate workloads.

## Notification-to-request flow

1. Backend writers emit `ETInboxChanged(message_id)` and fan it out to sessions.
2. `/api/event-stream/long-poll` returns accumulated events.
3. [Shared.elm](../../../wdintel-web/src/Shared.elm) extracts inbox events and sends them
   through `shared_dispatchInboxChanged`.
4. [interop.ts](../../../wdintel-web/src/interop.ts) dispatches the browser custom event
   `echo-inbox-changed`.
5. [useInboxChangedMessageIds.ts](../../../wdintel-web/src/ts/react/routes/shared/useInboxChangedMessageIds.ts)
   deduplicates pending message IDs and drains event batches sequentially.
6. [use-targeted-inbox-reconciliation.ts](../../../wdintel-web/src/ts/react/routes/rer-analysis-neo/use-targeted-inbox-reconciliation.ts)
   also maintains pending IDs and serializes reconciliation work.
7. [use-analysis-data.core.ts](../../../wdintel-web/src/ts/react/routes/rer-analysis-neo/use-analysis-data.core.ts),
   in `reconcileChangedMessagesBatch`, checks unseen IDs against the active
   filters with `fetchMessagesByIdsMatchingFilters`. Relevant results can
   cause hydration, comments, network data, and list/map reconciliation.
8. Its `finally` block schedules a recount when message membership changed,
   or schedules a deferred recount whenever `undisplayedMessageIds.length > 0`.
   The latter condition remains true even when the exact-ID lookup found
   no matching messages.
9. [use-analysis-message-counts.ts](../../../wdintel-web/src/ts/react/routes/rer-analysis-neo/use-analysis-message-counts.ts)
   coalesces recounts into five-second windows. Events arriving during a window
   mark another refresh pending. Sustained notifications keep that cycle going.

The important amplification is step 8: an unrelated unseen message can keep
the full-count refresh cycle alive for a narrow search.

An existing
[inbox-refresh spec](../../../wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-data.core.inbox-refresh.spec.tsx)
explicitly demonstrates this behavior. The test named
`does not reload when an accessible unseen id does not match server-only filters`
returns no exact-ID matches and expects no full reload or related hydration,
but still expects `scheduleOverallMessageCountRefresh('deferred')`.
The test was inspected, not executed during this investigation.

## Analysis findings and Pivnich search attribution

### Classic Analysis and counter scope

`/rer-analysis` filters inbox events to rendered message IDs, fetches those
messages, and updates cards and supporting metadata. Its event handlers do
**not** reload counters. See
[RerAnalysis.elm](../../../wdintel-web/src/Pages/RerAnalysis.elm) and
[EventRefresh.elm](../../../wdintel-web/src/Pages_/RerAnalysis/EventRefresh.elm).

Neo event-driven recounts refresh selected and overall **message totals**.
They do not reload every sidebar dimension counter. Those counters use the
regular initial/filter/manual reload path. No cross-tab random delay is added
to count scheduling; shared broadcasts can create correlated browser work.
The inspected handler does not reload the whole page.

### Route attribution

[helpers.ts](../../../wdintel-web/src/ts/react/routes/rer-analysis-neo/helpers.ts)
defines both:

- `ANALYSIS_ROUTE_PAGE_ID = 'rer-analysis-neo'`.
- `ANALYSIS_SESSION_ACTIVITY_PAGE_ID = 'rer-analysis'`.

The source explicitly keeps old and new Analysis grouped in session activity.
Therefore, the telemetry label alone cannot distinguish them.

Surviving request-header records associated with the repeated
`9oqm-001x-e0e0` search had a referer path of **`/rer-analysis-neo`** and a
Chrome 154 user agent on Windows. This confirms Neo for the inspected browser,
without establishing that every search-bearing activity record came from Neo.

### Managed AI activity

The production `ai_agent_request` and tool audit records showed:

| Observation | Result |
| --- | ---: |
| AI requests created today | 40 |
| Completed | 36 |
| Cancelled | 4 |
| Running or queued at inspection | 0 |
| Tool-start audit events today | 126 |
| `echo_inbox_messages` calls | 93 |
| Unit lookup calls | 16 |
| Attachment search calls | 1 |
| Other tool calls | 16 |

Observed tool calls occurred between approximately **06:04 and 06:58**. The
last managed request completed at **07:12:49**; no later tool calls were found
in the inspected records. Of the inbox calls, `JimForks` accounted for 36 and
`IsaacClarke` for 25.

This volume and timing do not explain the sustained repeated searches later
in the day. This finding concerns managed agent requests; it does not prove
that every background AI enrichment worker was inactive.

The high-volume search accounts below had ordinary `Rer` access rather than
`ApiAgent` access. Recent matching HTTP records had browser user agents.
The inspected `promin-api` integration read Iggy data and was not identified
as the source of the Analysis search pattern.
Account roles and browser user agents alone cannot exclude browser automation;
the inspected evidence does not identify such automation.

### Search-bearing Analysis activity

GreptimeDB `activity_page_visit` records with the Analysis page label and a
nonempty search showed:

| Period | Search-bearing activity records |
| --- | ---: |
| October 12, through approximately 13:53 | 16,922 |
| October 11, through the same cutoff | 1,630 |
| Increase | Approximately 10.38 times |

These are application activity records, not a count of unique people,
deliberate searches, all HTTP requests, or database executions. Both inbox
listing and count endpoints can record page activity. Empty-search overall
counts and changed-ID lookup requests are not captured by this nonempty-search
comparison.

| Account | Records today | Search pattern |
| --- | ---: | --- |
| `alex2710` | 7,161 | 299 distinct search strings; sampled activity included several concurrent searches and a query recurring about every five seconds |
| `tandryk` | 6,013 | All used `9oqm-001x-e0e0`; observed from 04:25:41 through 13:52:57 |
| `PCell` | 1,342 | All used `глаз`; observed approximately 06:28–08:36 |

Together, these accounts produced **14,516 records, or approximately 85.78%**
of the day's observed search-bearing Analysis activity.

For `tandryk`, the 13:50–13:52 samples repeated the same search every roughly
five to six seconds with `nolimit=true` and without before/since pagination
cursors. This is consistent with full filtered recounts rather than loading
the next page of results. The sampled `alex2710` requests also used
`nolimit=true`; concurrent repeated queries suggest multiple active views,
but a precise tab count was not established.

`Max3turbo` had 54 observed count events for `самовник` between approximately
13:00 and 13:52, with repeated 30-second timeouts and a roughly minute-long
recurrence. This is a separate slow-query symptom; its exact retry trigger
was not proven to be the five-second Neo scheduler.

A separate, broader 14:05–14:07 activity-details aggregate recorded 6,728
successful `get-inbox-count` responses, with approximately 95.9 ms mean
response time and 4,344 ms maximum. That sample was not isolated to this
Analysis view or account and includes counts without search text; it must not
be interpreted as a per-tab search rate.

### Request rates and what can be added together

| Traffic | Trigger and rate interpretation |
| --- | --- |
| Filtered full count | Normally about 12/minute per tab under a sustained pending-event stream: one every five seconds |
| Overall full count | Normally another 12/minute; preserves the selected time range and time basis while clearing the other filters |
| Changed-ID filter lookup | Event-batch driven; additional to recounts, but not necessarily one HTTP request per event |
| Hydration and related data | Conditional on the changed messages and current view; may add further requests |
| Event-stream long poll | Separate transport traffic; each response can carry many notifications |

The count handler sets `nolimit=true` for both count requests. If the filtered
and overall request definitions are identical, it shares one promise instead
of sending two requests. Thus **24/minute is the usual sustained recount
cadence for distinct requests**, not an exact total or a universal hard cap.
Initial loading, filter changes, and immediate refresh paths can also issue
requests.

The overall count retains the selected date range and time basis through
`buildInboxOverallCountReq`; "overall" does not mean all historical messages
without any access or time restriction.

Changed-ID lookups use
`/api/rer-importer/messages-by-id-matching-filters`. The backend builds the
filtered query with an explicit candidate-ID restriction in
[query.rs](../../../wdintel-rs/src/rer_importer/inbox/query.rs). These are additional
API calls, but their work differs from a full-range count; HTTP volume alone
does not establish database cost.

Long polling has a 500 ms minimum ordinary response time and the frontend
schedules the next poll after 100 ms. Poll responses and subsequent frontend
work can therefore batch several source events. Redis reads use a count of
1,000 per read, and session streams have an approximate retained cap of 1,000
entries; the sample is a bounded recent window.

For the numerical question raised during the investigation:

- The measured event rate was approximately **216/minute**, not 261.
- Assuming exactly one changed-ID request per event would give
  **24 + 216 = approximately 240 requests/minute/tab**, before other traffic.
- **24 + 261 = 285** is arithmetically correct, but 261 independent lookups/minute
  was not measured.
- The actual total depends on batching, duplicate IDs, view state, conditional
  fetches, transport requests, and the number of tabs. Neither 240 nor 285 was
  established as the actual total.

## Duty findings

### Classic Duty: one-second polling and broad event hydration

[`Waterfall.elm`](../../../wdintel-web/src/Pages_/RerDuty/Waterfall.elm) hard-codes
`loadingNewMessagesInterval = 1000`. Each waterfall runs its own loop:

- In manual-scroll mode it repeatedly requests an inbox digest/count when no
  digest or message request is already loading, then waits one second. Its
  unread count request uses an event-time date cursor and `nolimit = true`.
- In completed auto-scroll mode it polls newer message pages instead. Both
  modes create recurring backend work even without inbox-change events.
- Classic Duty does not consume `rer_duty_poll_interval_sec`. Changing the
  existing system setting does not slow these loops.

[`RerDuty.elm`](../../../wdintel-web/src/Pages/RerDuty.elm) also fetches **every unique
message ID** delivered in an inbox-change event batch, with `inboxReq = Nothing`.
Only after fetching does it retain updates for messages already in its
waterfalls. Tag updates to irrelevant or historical messages therefore cause
hydration requests in classic Duty tabs. Classic Analysis already filters to
rendered IDs before fetching; classic Duty can use that approach while leaving
its discovery polling intact.

### Duty Neo: independent poll triggers and multiple counts per feed

[`useRerDutyFeeds.ts`](../../../wdintel-web/src/ts/react/routes/rer-duty-neo/useRerDutyFeeds.ts)
reads system settings on mount and clamps its configured poll interval to at
least five seconds. The active database settings sampled at 14:09 UTC stored
one second on Skhid and five seconds on Pivnich. The current backend and Neo
frontend clamp the stored one-second value to five seconds; it is not evidence
that current Neo polls every second.

- A timer polls at the configured interval. Independently, an inbox-change
  batch calls `pollNow()` whenever five seconds have elapsed since the previous
  **event-triggered** poll. That timestamp does not track timer polls, and its
  fixed five-second threshold ignores a longer configured interval.
- Event-triggered polling runs even when none of the changed IDs is present in
  any feed. Visible-message hydration is filtered correctly in Neo, but the
  count cycle remains global to its feeds.
- Focus, online, and visibility recovery also request a poll. The recurring
  timer has no hidden-page guard; browser timer throttling may slow it, but the
  application does not suspend it. Counts include feeds whose card trees are
  currently inactive.
- [`useRerDutyPollingCoordinator.ts`](../../../wdintel-web/src/ts/react/routes/rer-duty-neo/useRerDutyPollingCoordinator.ts)
  coalesces overlapping cycles and allows a queued rerun. It does not enforce
  an interval between completed cycles. A fast event cycle can therefore run
  shortly before or after a timer cycle.
- [`useRerDutyFeedState.ts`](../../../wdintel-web/src/ts/react/routes/rer-duty-neo/useRerDutyFeedState.ts)
  requests an unread-cursor count for each eligible feed, concurrently. It
  shares an in-flight count within that feed, but removes the promise after
  completion and does not reuse a recently completed result.
- Scrolled-up feeds with positive unread counts can additionally request a
  count from the loaded tail. Tail availability checks use a separate request
  map in
  [`useRerDutyTailPollRequests.ts`](../../../wdintel-web/src/ts/react/routes/rer-duty-neo/useRerDutyTailPollRequests.ts).
  Some paths can repeat the same cursor/filter count rather than reuse the
  unread result. Different cursors legitimately need different counts.

These mechanisms explain how a nominal five-second interval can produce more
than one count per feed per five seconds. Multiple feeds and tabs multiply the
traffic further; there is no cross-tab scheduler.

### Production request evidence

A fresh five-minute activity sample around 14:11 UTC used the same `nolimit`
classifier as the Analysis sample:

| Request category | echo-skhid | echo-pivnich |
| --- | ---: | ---: |
| Classic Duty count-like requests | 11,022 | 10,763 |
| Distinct accounts making classic Duty counts | 16 | 13 |
| Duty Neo count-like requests | 3,421 | 8,035 |
| Distinct accounts making Duty Neo counts | 20 | 36 |
| Analysis count-like requests | 300 | 276 |

A separate three-minute sample ending around 14:14 UTC grouped requests by
account and canonical request payload, then compared consecutive timestamps:

| Measurement | echo-skhid | echo-pivnich |
| --- | ---: | ---: |
| Classic Duty requests | 6,290 | 6,660 |
| Classic repeated identical requests less than 1 s apart | 5,060 | 6,007 |
| Duty Neo requests | 2,179 | 5,101 |
| Neo repeated identical requests less than 4 s apart | 1,316 | 2,915 |
| Share of Neo repeat intervals less than 4 s | 63.9% | 59.5% |

The last percentage excludes the first request for each account/payload pair.
All classic requests in that cadence sample used date cursors; all Neo requests
used ID cursors. Account/payload grouping cannot distinguish feeds, tabs, or
poll reasons, so short repeat intervals demonstrate duplicate traffic, not the
exact cadence of a single feed. The five-minute sample also contained a small
minority of Neo-labelled event-time requests, consistent with older clients;
the label alone does not prove which frontend build generated a request.

### Duty source/gateway routing

In [`inbox/mod.rs`](../../../wdintel-rs/src/rer_importer/inbox/mod.rs), recent Duty
requests with `IMSTimestamp` and a date cursor within two days first attempt a
source PostgreSQL path, even when analytics is enabled. This matches classic
Duty's count shape. Current Neo uses `IMSCreatedAt` with ID cursors, so it does
not qualify for that specific fast path; supported requests can use the
source fresh-tail / analytics-history split, with source fallback.

## Source database and aggregate request measurements

Source PostgreSQL `pg_stat_statements` snapshots covered approximately
109 seconds between 13:52 and 13:54 UTC. The reset timestamp was unchanged.
Only top-level statements were compared, keyed by database user and query ID;
the earlier snapshots without the top-level distinction are not used here.

| Measurement | echo-skhid | echo-pivnich |
| --- | ---: | ---: |
| Sample duration | 109.3 s | 109.4 s |
| Total source SQL execution time | 892.2 s | 771.0 s |
| Inbox digest/count SQL calls | 1,278 | 1,836 |
| Inbox digest/count SQL execution time | 70.64 s | 90.13 s |
| Inbox digest/count share of source SQL execution time | 7.92% | 11.69% |

Execution time sums concurrent queries and is not CPU utilization. These count
figures include **all routes, especially Duty**, and exclude analytics-gateway
execution. They are an upper bound on direct source digest/count query work
an Analysis-only counter toggle could remove, not an estimate of its actual
savings or associated authorization/query-construction work.

A separate five-minute activity sample classified request payloads containing
`"nolimit":true` as count-like requests:

| Request category | echo-skhid | echo-pivnich |
| --- | ---: | ---: |
| Analysis count-like requests | 195 | 223 |
| Classic Duty count-like requests | 9,373 | 8,788 |
| Duty Neo count-like requests | 3,551 | 8,300 |

The classifier can include explicit unlimited message fetches. Neo Analysis
data requests deliberately use the `rer-analysis` activity label, so that label
does not distinguish classic and Neo Analysis. Bare page visits/heartbeats are
excluded from this table.

Other substantial source query costs included attachment-job discovery,
network frequency activity recalculation, spatial lookups, and message cursor
bound discovery. The evidence supports reducing automatic Analysis count work,
but does not establish it as the dominant cause of either server's load.

### Later source database sample

A second source PostgreSQL sample around 14:08–14:09 UTC again compared only
top-level statements with an unchanged statistics reset timestamp:

| Measurement | echo-skhid | echo-pivnich |
| --- | ---: | ---: |
| Sample duration | 58.2 s | 58.5 s |
| Total source SQL execution time | 972.12 s | 375.88 s |
| Inbox digest/count calls, all routes | 658 | 972 |
| Inbox digest/count execution time | 77.80 s | 49.07 s |
| Digest/count share of source SQL execution time | 8.00% | 13.05% |
| Message date-to-ID bounds queries | 647 | 929 |
| Bounds-query execution time | 35.87 s | 44.27 s |

Bounds discovery is shared by message retrieval and count routing; it cannot
be attributed entirely to Duty or counters. Concurrent SQL execution time is
not CPU time, and analytics-gateway execution remains outside this sample.
Other substantial costs remained: attachment-job discovery alone used
381.85 seconds on Skhid; network activity recalculation used 46.98 seconds on
Pivnich. Duty polling is a worthwhile optimization, not a complete explanation
of the servers' load.

## Slow requests and existing backend protection

Each background count refresh calls `abort()` on the previous browser count
controller before starting a new generation. If a count takes longer than the
refresh interval, the browser can repeatedly abandon and restart it. Backend
query cancellation after browser abort was not verified, so continued server
execution must not be assumed either way.

The deployed backend already contains `query_inbox_digest_singleflight` and
a successful count-result cache with a **five-second TTL**, configured in
[config.rs](../../../wdintel-rs/src/config.rs). Matching generated queries can share
work. Consequently, an HTTP count request is not necessarily a fresh database
count execution. Any backend optimization should account for this existing
mechanism rather than adding a duplicate cache blindly.

Commit `76b1fa9885255f4c278496709e7252a4a7a5a49d` from October 8, associated
with #3719, changed count scheduling. However, its parent already scheduled
overall count refreshes after unrelated reconciliation. This investigation
does **not** establish that #3719 introduced the broad invalidation behavior.
It also does not establish why the aggregate spike became noticeable today
rather than on an earlier day.

The existing five-second count cache starts **after** authorization, activity
recording, and query construction, including accessible-group lookup. Those
steps remain per-request work even on a count cache hit. Exact filters,
authorization scope, and cursors limit sharing. Date-to-ID bounds also have a
five-second cache, keyed by pool, ordering, exact dates, and routing choice in
[`query.rs`](../../../wdintel-rs/src/rer_importer/inbox/query.rs); differing cursor dates
can fragment it.

## Telemetry limitations discovered during request counting

A targeted query for 13:50–13:52, matching the repeated search in the request
referer, returned these surviving `event_type = 'request'` records:

| Endpoint | Surviving request records |
| --- | ---: |
| `/api/event-stream/long-poll` | 97 |
| `/api/rer-importer/get-inbox-count` | 13 |
| `/api/rer-importer/messages-by-id-matching-filters` | 3 |

These numbers are **not complete endpoint totals**.

The deployed
[activity middleware](../../../wdintel-rs/src/server/middleware.rs) stores Redis members
under `timestamp:request_id`, where the timestamp has second precision.
Request and response records share a request ID. If both occur in the same
second, they use the same Redis data key, and a response can overwrite the
request before the activity worker exports it. Response records omit request
headers, including the referer. Fast calls can therefore disappear from a
request-header-based account/view attribution query.

The activity worker periodically drains Redis; timing determines whether a
request record survives alongside its response. Summing request and response
rows is also unsafe without deduplicating request IDs. This explains why the
small referer-based sample cannot settle the requested per-tab total; it does
not quantify how many records were lost in that sample.

GreptimeDB request headers should be queried through JSON extraction functions
such as `json_get_string(request_headers, '$.referer')`. Casting the binary JSON
headers directly to text produced encoding errors during inspection.
A broad all-day request-details query hit its 25-second timeout; narrow windows
and aggregate queries were used instead.

Page-activity aggregates, request lifecycle/header records, and PostgreSQL
statement statistics are different datasets. The request-header overwrite
limitation does not make surviving referer-based rows complete HTTP totals;
nor should those rows be substituted for the separately scoped page-activity
or database samples.

## Recommendations after reviewing both reports

| Recommendation | Scope | Review status |
| --- | --- | --- |
| 1 | Analysis counter triggers, system-event interval, and optional disable switch | Scheduling implemented; server controls deferred |
| 2 | Duty polling, count reuse, and classic event-ID filtering | Implemented; Neo retains its existing polling setting |
| 3 | Request telemetry, worker attribution, and no-op notifications | Telemetry repair and verified AI-position skip suppression implemented; broad attribution deferred |
| 4 | One-server rollout and measurement before broader changes | Awaiting individual review |

### 1. Analysis: user-driven counts and throttled system recounts

Agreed policy: refresh on count-relevant user actions without the system-event
restriction. System-triggered recounts wait for whichever takes longer: five
seconds since the last count start, or completion of that count. Start with a
five-second default and expose the interval in system settings later.

For pending system work, the earliest next start is:

`max(last_count_started_at + 5 seconds, last_count_completed_at)`

The interval is measured from the previous start, not its completion. A cycle
that lasts two seconds permits a pending system recount at five seconds; a
cycle that lasts eight seconds permits it immediately after completion at
eight seconds. Completion covers all selected/overall count requests in the
cycle settling. Failure, cancellation, or a bounded deadline must release the
busy state as well, with the usual visible error handling.

Trigger rules:

| Trigger | Count behavior |
| --- | --- |
| Initial load; user changes search, filters, dates, or time basis | Refresh for the current query; cancel obsolete requests and reject their results |
| User explicitly refreshes or makes a mutation that affects totals | Request a refresh without the system-event throttle |
| System inbox-change event | Mark counts dirty; start only when the interval has elapsed and the current count cycle has settled |
| System event while within the interval or a count is running | Keep one pending refresh; do not abort/restart an active count or postpone the due time for each new event |

User actions that do not affect totals, such as opening a menu, need no count
request. Search typing can retain its existing short debounce. A user-triggered
count should move the next eligible system refresh to at least five seconds
after that start, preventing an immediate duplicate background recount.
System scheduling also waits for that user-triggered cycle to finish. Repeated
system events must not postpone the pending refresh indefinitely. If events
arrive during a cycle, keep one pending refresh and run it once both conditions
are met, even if no further event arrives. Without pending events, do not run
recurring count requests merely because the interval elapsed.

Always validate the query scope and request generation before applying a result.
When the user changes filters, an earlier result must never replace counts for
the new filters, even if cancelling the request fails. A result for unchanged
filters can lag changing data without being irrelevant to the current query;
these are different freshness problems.

#### What changes compared with the inspected baseline scheduler

The baseline Neo code coalesces most system recounts into five-second windows in
[use-analysis-message-counts.ts](../../../wdintel-web/src/ts/react/routes/rer-analysis-neo/use-analysis-message-counts.ts).
That is not a strict minimum between request starts: a deferred event can open
a window, an immediate membership update can start a count late in that window,
and a subsequent pending event can cause another count at the original boundary.
Implementing the agreed policy should use the last actual count start, including
user-triggered starts, rather than only the existing window's timer, and wait
for all requests in the active cycle to settle. Only user actions that replace
the current work can interrupt it; system events cannot abort or overlap it.

Five seconds by itself is therefore not a new large reduction over the observed
sustained recount cadence. The useful changes are making the limit strict,
keeping user actions independent of it, and allowing a larger interval or an
opt-out on struggling servers after measurement.

#### Remaining downsides

- System-triggered totals lag by the scheduling wait plus query time. Backend
  count-cache age and analytics replication delay can add further lag; five
  seconds is a request-start limit, not a guaranteed freshness bound.
- A continuous event stream can still sustain approximately 12 refresh cycles
  per minute per tab, commonly two count requests per cycle. This bounds each
  tab's rate but does not cap aggregate server work across users and tabs, or
  reduce changed-ID lookups.
- A slow count now finishes instead of being restarted by system events, but
  its data snapshot can lag more than five seconds. Pending events trigger a
  follow-up once eligible. A bounded deadline prevents a stuck request from
  blocking system recounts indefinitely. User actions remain immediate and
  cancel/invalidate obsolete work; verify server cancellation separately.
- The backend already reuses successful count results for five seconds, without
  a message-write invalidation path in the inspected count cache. An immediate
  user mutation/manual refresh can therefore return an older cached result for
  the same query. If those actions must observe the write immediately, cache
  bypass/invalidation and analytics visibility need a separate solution.

#### Deferred proposal: per-server Analysis controls

The following switch and interval controls are retained as reviewed proposals;
they are not implemented in iteration 2. The implemented interval is fixed at
five seconds.

Add `disable_analysis_live_counter_updates`, false when unset in application
code. Gate **event-driven selected/overall count refreshes in Neo Analysis**,
cancel queued/background work when disabling, and preserve initial,
filter-change, and explicit refresh counts. Continue list/map reconciliation
and visible-message updates. Classic Analysis has no equivalent live-counter
path to disable, and the switch should not implicitly change Duty.

Label the setting explicitly. Make stale totals understandable, preferably
with their last-update time and a manual refresh action. This switch reduces
recounts; it does not eliminate changed-ID filter lookups or prove a particular
CPU saving.

Follow the existing system-settings revision/activation mechanism, nullable
migration conventions without a SQL default, analytics impact declarations,
and generated backend/frontend bindings. Settings currently load once at page
mount: require a reload of existing tabs for the first rollout, or implement
settings propagation if immediate shutdown in already-open tabs is required.

### 2. Duty request reductions

Review direction: keep Neo Duty's existing data-polling interval and existing
system setting. Do not introduce a new interval setting or change its default
to 2.5 or three seconds. The current minimum/default remains five seconds;
longer configured intervals remain effective.

Automatic count refreshes should run at that same pace per feed, waiting until
both the configured interval since the previous count-cycle start has elapsed
and its count requests have settled. Keep at most one pending cycle. Inbox
change events must not start additional count cycles between periodic polls.
Recovery checks should coalesce with due work rather than create extra automatic
count cycles. Initial loads and explicit count-relevant user actions remain
immediate; query changes cancel/invalidate obsolete requests. Healthy feeds
must continue independently when another feed's count is slow.

This limits count-cycle frequency, not the number of distinct answers needed
within a cycle. Unread-cursor and loaded-tail counts can answer different
questions. Reuse a result when filters and cursors match; otherwise each may
need one request in the same cycle. Do not impose a single-count-per-tab limit
that leaves other feeds or tail availability incorrect.

Both query types already exist; this distinction does not introduce additional
count requests. For example, with six unread messages already loaded and three
newer messages not yet loaded, the count after the last-read cursor is nine,
while the count after the loaded-tail cursor is three. Reusing nine as the tail
count would incorrectly treat already-loaded messages as unloaded. Preserve
each answer unless filters and cursors match. The scheduling change can delay
automatic counts and new-message notifications until the next successful poll;
verify badge accuracy, notifications, and scrolling behavior when implementing.

Keep targeted inbox-event refreshes for displayed messages. Periodic polling
counts and loads newer pages; it does not routinely refresh existing cards'
tags, edits, or deletions. Removing all inbox-event handling would leave those
cards stale. Classic Duty should filter IDs before that targeted fetch.

Using periodic counts instead of extra event-triggered counts can delay
discovery and notification decisions until the next successful poll. Browser
timer throttling in hidden tabs can make this delay longer than the configured
interval, so preserve reconnect/visibility recovery and verify hidden-page
notifications. This is a latency tradeoff, not proof that additional event
polling never helps. The implementation status is recorded in the iteration 2 results below.

Remaining implementation proposals:

1. Make classic Duty honor `rer_duty_poll_interval_sec`, with the existing
   five-second minimum, for its recurring count/newer-page loop. Preserve
   immediate initial loads and explicit user actions. For an idle manual-scroll
   feed, increasing one second to five seconds reduces scheduled count HTTP
   requests by approximately 80%; this is not an estimate of total database
   or server-load savings.
2. Filter classic Duty broadcast IDs against rendered feed message IDs
   **before** calling `getMessagesByIds`. Polling remains responsible for
   discovering new messages.
3. Keep Neo's periodic polling interval and make automatic counts share that
   schedule. Remove the separate inbox-event `pollNow()` kick while retaining
   visible-message hydration. Coalesce recovery checks, prevent overlapping
   count cycles, and retain bounded failure recovery and stale-result guards.
4. Reuse a validated unread result for a tail count when cursor and filters
   match. Keep separate requests when they answer different questions, and
   preserve stale-result guards when cursors or filters change.

No new Duty event-count switch is proposed: periodic polling remains responsible
for automatic counts. This supersedes the earlier suggestion to unify inbox
event and timer count triggers while retaining both as independent sources.
Classic Duty's hard-coded one-second loop remains a separate proposal for review.

Do not disable all Duty polling: counts support new-message discovery,
empty-feed recovery, unread badges, notification baselines, and tail catch-up.
Preserve hidden-page notifications and unread/follow/scroll behavior. Keep the
[Duty Neo creation-time contract](../../../docs/duty/README.md#creation-time-contract);
do not switch Neo to event-time ordering to obtain the classic source fast path.

### Next: explicit Analysis freshness and bounded incremental work

Separate filtered-total invalidation from overall-total invalidation. An
unrelated update should not require refreshing both as often as a relevant one.
Without before/after filter membership, however, an empty exact-ID response
cannot distinguish an unrelated message from an unseen removal. Keep periodic
reconciliation or add sufficient invalidation information to cover additions,
removals, deletions, edits, permissions, and time-range transitions.

A longer bounded automatic count interval, such as 30–60 seconds, is an option
to evaluate against freshness requirements, not a validated production default.
Refresh on returning to an active tab and manual refresh can complement that
policy. The explicit opt-out intentionally accepts stale totals until another
count action; a default automatic policy needs a defined freshness bound.

Incremental lookups already deduplicate pending IDs and serialize batches.
Evaluate a short intentional batching window and bounded batch sizes if
measurements show these requests remain significant after recount fixes.
Preserve updates that arrive while a batch is in flight. Equal message IDs do
not prove equal data states; do not permanently drop successive updates based
only on their ID.

### 3. Attribution, telemetry, and no-op notifications

Repair request telemetry by including event type in its Redis member/data key
or retaining one lifecycle record with request context and completion data.
Preserve safe attribution across fast responses without recording credentials
or message bodies. Add actual route/version dimensions alongside the shared
Analysis activity label; do not reinterpret historical `rer-analysis` labels
as proof of the classic route.

Record emitting component, reason, message/version, and whether fields relevant
to filters or count membership changed. Worker attribution can remain internal;
clients need only enough information to select the correct refresh. Update
backend definitions and generated bindings if the event schema changes.

[AI callsign](../../../wdintel-rs/src/ai_callsign/worker.rs) and
[AI settlement](../../../wdintel-rs/src/ai_settlement/worker.rs) already gate fanout on
a `changed` result. In
[AI position](../../../wdintel-rs/src/ai_position/worker.rs), successful `complete_job`
causes fanout even when stale-source or re-enqueued-job branches return without
applying changes. Review that function's changed-state reporting and suppress
those no-op notifications while preserving notifications for actual changes.
This is a verified code opportunity, not proof that this worker caused the
sampled volume.

Measure separately by host and actual view:

- Events by emitting component/reason and deduplicated reconciliation batches.
- Changed-ID, filtered-count, overall-count, unread-count, and tail-count requests.
- Trigger reason, completions, aborts, latency, errors, and deadlines.
- Cache hits, shared in-flight work, source/gateway executions, and bounds costs.
- Open/active tabs and visibility, with safe account/tab attribution where available.

### Later: broader backend or notification changes

Consider access/source/time-scoped subscriptions only after the smaller fixes
are measured. Routing must cover messages moving into or out of a scope,
permissions, deletions, reconnect catch-up, and stream retention; endpoints must
continue authorizing independently.

Do not add another count cache blindly: five-second count and bounds caches
already exist. Evaluate longer caching or cross-view sharing with measured hit
rates and costs, preserving authorization, exact filters, dates, and time basis.
If expensive queries remain, review representative plans and sustained behavior
using [QUERY_PERF.md](../../../QUERY_PERF.md). Avoid assuming fewer HTTP requests means
the same proportional reduction in SQL execution or total load.

## 4. Implementation validation and rollout

Implement these performance fixes from `stable` in reviewable changes.
Changes to system settings must follow existing revision, migration, analytics,
and generated-binding requirements.

For Analysis, exercise sustained unrelated events and repeated updates to the
same message. Verify user-triggered refreshes bypass system throttling, outdated
query results cannot apply, and pending system work survives a quiet period.
Exercise a deferred event followed by an immediate membership update near a
window boundary to verify the system-event interval. Assert that a two-second
cycle permits pending system work at five seconds, an eight-second cycle permits
it at completion, and neither system events nor timer expiry abort or overlap
the active cycle. Cover a quiet period after an in-flight event, both count
requests settling, failures/deadlines releasing the busy state, and immediate
user-triggered refreshes during the wait. Cover matching
unseen additions, unseen removals, deletion,
visible-message edits, map filters, date/time-basis changes, slow counts lasting
over five seconds, and filter changes during requests. Validate multiple-tab
load during rollout; disabling queued/in-flight work applies only if the
deferred switch is introduced. Assert bounded work and the chosen freshness
policy while preserving live list/map updates and visible API errors. Update
the existing nonmatching-unseen-ID expectation with any intentional policy
change, not in isolation.

For Duty, verify inbox events refresh displayed messages without starting extra
count cycles, including when events arrive during a count or near a timer tick.
Verify the existing configured interval controls automatic counts, recovery
checks coalesce, and slow counts do not overlap or block healthy feeds. Cover
filter/cursor changes, failures, empty-feed recovery, manual actions, unread
badges, tail catch-up, and hidden-page notifications. Verify identical unread/tail
counts share a validated result while different cursors remain independent.
Retain creation-order and scroll/follow regressions.

Run focused affected regressions and the full frontend build for implementation;
backend changes need the applicable Rust checks and performance evidence.
The original report merge changed documentation only; iteration 2 implements
the authorized scope and records validation below.

Deploy to one server first, initially using the five-second Duty interval.
Reload already-open tabs so the deployed frontend and settings actually apply.
Record previous settings and release. Compare equivalent time windows, searches,
filters, and user activity; track requests, errors/latency, cache reuse, source
query time, bounds costs, and gateway work when accessible.

Iteration 2 has no Analysis opt-out to enable. If that deferred control is later
implemented, measure its incremental effect separately from Duty changes.
Trial a longer existing Duty interval only after checking discovery and
notification latency. Expand to the other server after behavior and load checks.
Restore prior settings or roll back the release if discovery, unread, or
notification behavior regresses. No rollout or settings changes were performed.

## Confidence, limits, and completed validation

Both reports' unique measurements and proposals are consolidated here. Their
different sample times and data sources are retained rather than added together.
The merge review checked the relevant source paths, the identified deployed
commit and scheduling history, arithmetic, and available source PostgreSQL
snapshot summaries. Historical production observations from the second report
remain attributed to its original inspection; this review did not recreate
those daily queries.

The earlier Duty investigation ran
[useRerDutyFeeds.spec.ts](../../../wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeeds.spec.ts):
all 14 tests passed, including the assertion that non-overlapping events still
poll. The `shares one count request per feed across concurrent callers` case in
[useRerDutyFeedState.polling.spec.tsx](../../../wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.polling.spec.tsx)
passed, as did design-token and test-structure checks. Selecting the non-overlap
case alone initially failed in React test setup; its complete suite passed.
The Analysis nonmatching-unseen-ID test was inspected, not executed. No
application tests were rerun for the documentation merge.

Production analytics uses separate PostgreSQL gateways. The application role
could not read gateway `pg_stat_statements`, and attempted SSH did not provide
administrator access; gateway execution costs remain unmeasured. All-route
count and bounds work cannot be assigned entirely to Analysis or Duty, and
summed SQL execution time is not CPU utilization.

Remaining uncertainties are the exact per-tab HTTP total, cost attributable to
each route/search, worker contributions, server cancellation after a browser
abort, client versions/visibility for all requests, and why today's search spike
exceeded yesterday's. Managed-agent audit results do not rule out enrichment
workers or browser automation. The evidence does not justify stopping a worker
solely on suspicion.

The investigation and report merge changed no application code or production
settings, services, workers, or database data. Iteration 2 subsequently changed
local application code and used dedicated test databases, as recorded below.
This file replaces the two source reports and retains their findings and
reviewed recommendations.


## Iteration 2 implementation and investigation results

### Applied changes

- Analysis Neo uses one count-cycle implementation for initial/user and system
  refreshes. System events retain one dirty refresh until the previous cycle
  settles and five seconds have elapsed since its actual start. Both selected
  and overall requests must settle, including after one fails. Matching requests
  share one result; user query changes still abort/invalidate obsolete work.
  A 65-second deadline aborts stuck requests, reports an error, and releases the
  scheduler. Scheduling uses a monotonic clock so wall-clock adjustments cannot
  strand pending work.
- Duty Neo removes the independent inbox-event count kick while keeping
  displayed-message hydration. Automatic count eligibility is tracked per feed
  at the existing configured interval. Recovery calls coalesce with due work;
  an early timer schedules the remaining delay instead of skipping an entire
  polling interval because of timer jitter. Active unread/tail counts prevent
  overlapping automatic counts for that feed. Healthy feeds remain independent.
- Duty reuses validated unread results for identical loaded-tail boundaries,
  including scrolled-up and exhausted-tail paths. Separate cursor questions keep
  separate requests. Initial loads and user navigation/filter actions remain
  outside this automatic-count restriction.
- Classic Duty derives recurring count/newer-page delays from the existing
  `rerDutyPollIntervalSec` setting with a five-second minimum. Its one-second
  local clock tick and event-stream transport retry remain separate. Inbox
  event IDs are filtered against loaded messages before hydration.
- Telemetry Redis members now include lifecycle event type. The payload and
  sorted-set publication are atomic, closing a second race where the exporter
  could observe an entry before its payload existed. Exporter lookup is based
  on the member string, so it can drain old and new member formats without a
  schema migration. The documented GreptimeDB table already includes
  `event_type` in its primary key. Redis inspection examples and lifecycle-count
  semantics are updated in
  [ACTIVITY_TRACKING_EXAMPLE.md](../../../wdintel-rs/docs/ACTIVITY_TRACKING_EXAMPLE.md).
- The telemetry investigation also verified that all incoming headers were
  retained, including authentication headers. The writer now retains only
  context headers (referer, origin, user agent, content type, accept, host, and
  request ID). Request bodies remain unrecorded. This preserves route/view
  context without persisting cookies, bearer tokens, or arbitrary API-key
  headers. Historical retained credentials are outside this local change.
- AI-position completion returns whether it committed mention replacement.
  Verified stale-source and re-enqueued-job skips return false and do not
  broadcast inbox changes; committed replacement still broadcasts. No event is
  suppressed merely because a message ID or payload repeats. Callsign and
  settlement workers already gate fanout on their changed result; network
  invalidation does not directly emit inbox changes in the inspected path.

### Practical limits

The frontend policy limits per-feed/per-tab request starts; it does not impose
one count per tab or cap aggregate work across tabs/users. Discovery and
notifications may wait until the next successful periodic check, especially in
hidden tabs. Existing backend count-cache age and analytics replication delay
still apply. No new settings or database migrations were introduced.

Repairing telemetry can increase Redis/exporter traffic because fast requests
now retain both lifecycle records. The existing 10,000-record cap and TTL remain
unchanged, so their HTTP-request coverage can shrink during an exporter backlog.
Measure lifecycle rows separately and deduplicate request IDs for HTTP totals.
Neither this repair nor worker skip suppression establishes a production CPU
saving; worker attribution and post-rollout measurements remain necessary.

### Validation

Checks run against the local implementation:

- `cargo check -p wdintel-rs`: passed.
- `cargo clippy -p wdintel-rs --all-targets --all-features -- -D warnings`:
  passed, including the final error-context adjustment.
- Database-backed regressions used dedicated databases
  `wd_test_3780_sys_events` and `wd_files_test_3780_sys_events`, restored from the
  standard dump. With `TEST_DB_NAME` and `TEST_WDFILE_DB_NAME` set accordingly,
  `cargo test -p wdintel-rs --bin wdintel-rs 3780 -- --test-threads=1` passed all
  three regressions on the final implementation (two telemetry tests and
  stale-source completion).
  `cargo test -p wdintel-rs --bin wdintel-rs ai_position::worker::tests -- --test-threads=1`
  passed all ten worker tests, including successful replacement and the
  re-enqueued-job skip. Telemetry tests use Redis database 15 and remove only
  their own UUID-tagged records.
- `cd wdintel-web && npm run test:ts -- --maxWorkers=4`: passed all 380 files /
  3,073 tests on the final implementation, including the pending-due timer and
  its regression. The affected Duty route suite also passed 36 files / 425
  tests; its polling suite contains 41 passing tests. The full run includes
  the Analysis and #3546 creation-order regressions. An initial run with unrestricted
  workers hit an unrelated pagination-control timing failure; the complete
  four-worker run passed without changing that test.
- `npm run format:staged`, `npm run test:structure-check`, design-token checks,
  `npm exec -- elm make src/Pages/RerDuty.elm --output=/dev/null`, and
  `just build-front`: passed, including a full build after the final classic
  event-ID filtering change. Rust formatting checks pass for all three changed
  Rust files. `git diff --check` passes, and archived local Markdown links resolve.
- Affected Chromium suites covered Analysis, Duty scrolling/following, direct
  links/short state, and creation ordering. Across the 37 selected cases,
  36 passed after focused reruns. The sustained Analysis realtime scenario
  requires several actual five-second quiet/count windows; its existing
  30-second test limit was too short. A per-test 60-second limit passed in
  27.4 seconds without changing its behavior assertions. The initially failing
  Duty ON-settings case passed on rerun.

Two baseline checks remain outside these fixes:

1. `rer-duty-scroll-stability.spec.ts` case
   `restores every feed position through editor tabs and close @regression`
   fails at the second editor-tab anchor assertion (line 250). It was reproduced
   in an isolated, unchanged checkout at `2916530ec`: expected message 37,
   received 27 (the implementation run also produced 24). This is an existing
   editor-scroll regression; the affected browser suites are not completely
   green, so do not describe this result as full E2E clearance for merging.
2. `cargo fmt --all -- --check` reports pre-existing formatting in the unchanged
   `wdintel-rs/src/messenger/worker/mod.rs` (lines 1552, 1592, and 1600). The
   unrelated formatter-only changes were reverted; changed Rust files pass
   `rustfmt --edition 2021 --check`.

No production deployment, settings changes, or post-rollout load measurements
were performed. The request reductions are verified locally; their total CPU
and database impact still requires the reviewed one-server measurement.
