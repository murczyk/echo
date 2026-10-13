# Analysis polling after iteration 2 (#3780)

Read-only follow-up on `echo-pivnich`, **2026-10-13**, to
[iteration 2](../iteration2/findings.md). All times are UTC.
No production settings, services, workers, or data were changed.

## Result

Iteration 2 did not resolve the Analysis request storm. Its count scheduler
fixes are present and pass the affected regressions, but it intentionally left
the 500 ms event-stream response window and immediate message reconciliation
unchanged. The original report already stated that five seconds was not a
large reduction over the previous sustained count cadence.

Deployment is confirmed: package `0.1.1~rc.202610122204-1` was installed at
07:12:45, the API service started at 07:12:52, and the served version identifies
commit `af53625bf0b`. That commit includes `f478472b2` and `6cd0af45f`.
Its Analysis count hook is byte-identical to the current checkout.
This identifies the served release, not the JavaScript already running in
every open tab. Older tabs still need reloading.

## Measurements

The [sanitized evidence](measurements.json) retains the windows, HTTP totals,
view attribution, and live Redis samples.

GreptimeDB is shared by several Echo deployments. Every retained HTTP query
restricts `request_hostname` to
`echo-pivnich.hyakutake-chromatic.ts.net` or `pivnich.echoua.info`.
HTTP totals use `COUNT(DISTINCT request_id)` across lifecycle records.
Summing request and response records would double-count the repaired telemetry.

### Before and after deployment, all Pivnich views

| Endpoint | Before: 06:50–06:55 | After: 07:40–07:45 | Change |
| --- | ---: | ---: | ---: |
| long-poll | 83,662 | 82,691 | −1.2% |
| get-inbox-count | 16,893 | 16,105 | −4.7% |
| messages-by-id-matching-filters | 2,252 | 2,997 | +33.1% |
| messages-by-id | 5,094 | 4,514 | −11.4% |
| comments-batch | 54 | 221 | +309.3% |

There is no large aggregate reduction in these windows. These are observational
samples, not a controlled performance comparison: user activity, filters, feeds,
and open tabs differ. Older telemetry also has the overwrite/export limitations
described in iteration 2, so the percentages are observed retained-request
changes, not a precise estimate of the code's effect.

Independent page-activity records with `nolimit=true`, which were not changed
by the HTTP lifecycle-key repair, show:

| Page activity label | Before: records / accounts | After: records / accounts |
| --- | ---: | ---: |
| rer-analysis | 249 / 4 | 609 / 8 |
| rer-duty | 8,112 / 9 | 7,878 / 9 |
| rer-duty-neo | 7,991 / 39 | 7,131 / 38 |

These are count-like activity records and may include unlimited message fetches.
The Analysis label groups classic and Neo. More Analysis accounts were active
after deployment; the increased Analysis total does not establish a scheduler
regression. Even Duty's intended reductions have not produced a large
server-wide reduction in this sample.

### Current Analysis traffic, 07:40–07:45

Actual view attribution uses the request referer, separately from page activity.

| Endpoint | Classic Analysis | Analysis Neo |
| --- | ---: | ---: |
| long-poll | 52,397 | 3,475 |
| get-inbox-count | 0 | 608 |
| messages-by-id-matching-filters | 0 | 2,997 |
| messages-by-id | 11 | 71 |
| comments-batch | 45 | 176 |

These are aggregate view totals, not requests from one tab. Classic Analysis
accounts for about 63% of all retained Pivnich long polls in this window.

Two stable Neo referer/browser groups made 118 and 114 count requests in five
minutes: 23.6 and 22.8 per minute. This is consistent with two counts per
five-second cycle, not a count cycle every 500 ms. The same groups made 246 and
237 filtered-ID lookups. Another group made 160 comment requests, 165 filtered-ID
lookups, and 61 hydration requests. Referer/browser groups can contain multiple
tabs and are not reliable tab identifiers.

A separate 45.085-second Redis observation at 07:49:12–07:49:57 captured Neo's
423 long polls, 355 filtered-ID lookups, 84 counts, eight comment requests, and
two hydration requests. Matched responses were all HTTP 200. Long-poll median
response time was 512 ms; filtered-ID lookups were 39 ms and comments 20 ms.
Successful fast requests drive the loop; this sample is not an error-retry storm.
This short live capture is supplementary, not the authoritative historical total:
the exporter drains the buffer concurrently, and some records can be missed.

At 07:57:37, three session streams each retained 1,000 inbox-change events over
about 281.74 seconds: **212.96 events/minute**, close to iteration 2's 216.
One stream contained 357 distinct message IDs and 643 additional events for
those IDs; all 1,000 had null origins. The registry held 124 sessions.
An earlier observation in this investigation measured 221.84 events/minute.
The three later streams repeat the same broadcast workload; their event counts
must not be added together. Repeated IDs do not prove no-op writes.

## Why requests continue

1. [The server](../../../wdintel-rs/src/event_stream/mod.rs) still accumulates
   ordinary events for only
   [500 ms](../../../wdintel-rs/src/config.rs).
   [Shared](../../../wdintel-web/src/Shared.elm) starts the next poll after
   100 ms. Frequent events keep this transport busy on every view.
2. [Classic Analysis](../../../wdintel-web/src/Pages/RerAnalysis.elm) starts
   another long-poll loop at page initialization and immediately repeats it
   after each successful response. Shared polling also starts after login.
   The page's subscription registry does not deliver these events back to the
   page; simply deleting its loop would break visible-message updates.
   This duplicate transport path was outside iteration 2's implementation.
3. [The inbox listener](../../../wdintel-web/src/ts/react/routes/shared/useInboxChangedMessageIds.ts)
   drains immediately. [Targeted reconciliation](../../../wdintel-web/src/ts/react/routes/rer-analysis-neo/use-targeted-inbox-reconciliation.ts)
   serializes and deduplicates pending IDs, but starts the next batch in a
   microtask and has no time interval. Fast requests finish before the next
   event batch arrives, so serialization does not reduce their sustained rate.
4. [Neo reconciliation](../../../wdintel-web/src/ts/react/routes/rer-analysis-neo/use-analysis-data.core.ts)
   checks unseen IDs against filters and forcibly reloads comments for kept
   messages. Generic inbox events contain no comment-change or membership
   information. A tag/enrichment event can therefore cause a comment request.
   Even a rejected unseen ID marks the full totals dirty.
5. [Counts](../../../wdintel-web/src/ts/react/routes/rer-analysis-neo/use-analysis-message-counts.ts)
   now respect the start interval and wait for both requests to settle, but
   that interval remains five seconds. Narrow searches still get repeated
   selected and overall counts under unrelated broadcasts.

The recently added API quota applies to the exact `Api` role. It does not
provide a rate limit for ordinary browser users; see
[API request limits](../../../docs/api-rate-limiting.md).

## Proposed fix

Prioritize the unchanged transport and reconciliation paths; another repair of
the five-second scheduler alone will not address the observed storm.

1. Trial a **two-second server accumulation window**, using the existing
   central constant, while retaining the long idle block and immediate
   deployment-maintenance signaling. Under sustained backlog this caps one
   ordinary poll chain at 30 response cycles/minute, or about 28.6 with Shared's
   100 ms delay. The current ordinary ceiling is about 100/minute for Shared
   and 120/minute for a page loop. These are calculated ceilings, not measured
   savings. This change also slows already-open older clients without relying
   on their reload.
2. Connect classic Analysis to Shared's inbox events and remove its private
   poll loop. Preserve filtering to rendered IDs and visible API errors.
   Verify only one poll is in flight per tab across navigation, login/logout,
   reconnection, and late responses. Do not claim an exact twofold production
   reduction from the source-level duplication.
3. Consider an independent **two-second start interval** for Analysis
   reconciliation, retaining one pending set while work runs. Keep updates
   received during a request and drain pending work after a quiet period.
   Scope changes invalidate obsolete results. Keep explicit user mutations
   immediate. A transport window alone does not protect against local-origin
   reconciliation or other direct callers.
4. Trial **30 seconds for system-triggered selected/overall totals**, keeping
   initial loads, query changes, manual refresh, and user mutations immediate.
   This permits at most two automatic cycles/minute, usually four count
   requests rather than 24. The tradeoff is up to 30 seconds of scheduling
   delay, plus query/cache/replication delay. Keep a bounded periodic dirty
   refresh: a nonmatching unseen ID may represent removal outside the loaded
   window, so dropping its invalidation would make totals incorrect.
5. Batch comment reloads through the same reconciliation interval. Skipping
   them merely because the message payload is unchanged is unsafe: a
   comment-only change can leave that payload unchanged. Separate comment or
   membership revisions, producer attribution, access-scoped subscriptions,
   and cross-tab transport sharing remain later work.

Two seconds and 30 seconds are proposed canary values, not validated production
defaults. Server batching affects other event consumers, so check Duty's
visible edits, discovery, unread counts, and notifications as well.

### Review after removing the ID cap

The proposed batch-size limit has been withdrawn. No oversized-request
performance failure was measured, and splitting a pending batch into chunks
can increase requests and delay catch-up. Reconciliation should retain its
existing deduplication and drain all pending IDs together.

The independent frontend interval is optional: with a two-second server
window, ordinary Shared event delivery is already paced. Its additional benefit
for direct reconciliation callers has not been measured. Start with the server
window, one shared poll loop for classic Analysis, and a longer automatic-count
interval; measure remaining reconciliation traffic before adding another timer.
Comment requests already belong to reconciliation, so no separate comment
scheduler is proposed.

Two seconds and 30 seconds are freshness choices with calculated request-rate
effects, not measured optimal values. The server window affects all event
consumers. Changes to existing user-action behavior should be excluded:
preserving immediate actions does not justify adding unconditional total
recounts to every bookmark, importance, or tag mutation. Extra Shared restart
guards protect a potential lifecycle race, but that race was not identified as
the cause of the production storm and should be reviewed separately.

The in-progress implementation remains a draft pending this review. Only the
ID-cap removal and its associated test/documentation changes were authorized
by the review request; the other draft changes have not been finalized or
deployed.

## Validation and acceptance

The existing local regression suites passed: **74 tests** across
`use-analysis-message-list.spec.ts` and
`use-analysis-data.core.inbox-refresh.spec.tsx`.
The browser regression rejecting unrelated events passed and explicitly expects
one filtered-ID lookup per event, followed by a deferred recount.
The sustained mixed-stream browser test initially failed while waiting for the
initial count display; its isolated rerun passed in 30.3 seconds.
No product code was changed, and this is not full frontend/E2E clearance.

For implementation, measure one identified tab with sustained four-per-second
events, repeated IDs, comment-only updates, visible deletions, unseen additions
and removals, query changes, and slow requests. Assert one transport chain,
no overlapping reconciliation, the selected start intervals, no stale result
application, pending work after quiet periods, and immediate user actions.
Add bounded request-count assertions: the current browser regressions preserve
updates but do not require a low rate for the transport or filtered-ID lookups.

Canary one server and reload old tabs for the frontend changes. Capture the
client version, tab identity, visibility, trigger, and request start/completion
so multiple views cannot be mistaken for one rapid loop. Compare host-scoped,
request-ID-deduplicated windows with comparable filters and user activity.
Check initial-loading cost separately from recurring work, and include errors,
latency, database execution, and ingest delay. No implementation or canary
deployment was performed in this investigation.

