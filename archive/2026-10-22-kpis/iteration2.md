# KPI — Iteration 2 backlog

Issue: [#3826](https://github.com/echoua/echo/issues/3826). Original wishlist: [idea.md](idea.md). The delivered, existing-API scope is in [iteration1.md](iteration1.md). All unclear metrics and work needing APIs, event history, identity mappings, or new data belong here. They are not promised by Iteration 1.

## Unresolved definitions

- [ ] Agree the “жива база” formula, including manual account blocks, disabled organisms, technical accounts, and timestamp reliability. Suggested starting point: available accounts plus accounts deactivated for inactivity within 90 days, but validate whether this describes the intended population before adding a card.
- [ ] Agree whether product metrics count accounts, people, or deduplicated web/bot identities; define treatment of service and technical accounts. Iteration 1 deliberately shows the full retained account list with explicit filters.
- [ ] Identify reliable job-position and military-unit mappings. Current system roles, organisms, and directions remain labelled as those fields rather than substituted for these dimensions.
- [ ] Rada/product owner selects the key action, onboarding steps, feature list, and eligible audiences before activation/adoption instrumentation.
- [ ] Define activity, time windows, timezone, session boundaries, abandonment, churn, return, first view, reaction deadlines, and supported history coverage before building their metrics.

## Existing-history workstream

- [ ] Before adding each historical metric, verify source availability, retention, event meaning, stable account identity, host isolation, missing/dropped events, and query cost. Use bounded server-side aggregation through an admin-only API in a separate implementation plan; do not connect the browser directly to Greptime/PostgreSQL or pass service credentials to it. Existing data may avoid new instrumentation, but still needs a supported read API.
- [ ] Define “active” from qualifying human actions, choose calendar vs rolling windows and timezone, and specify account/service/bot inclusion. Optional Greptime and its bounded, lossy activity queue require coverage indicators; unavailable history must display as unavailable, never as zero. A keep-alive alone does not prove interaction.
- [ ] Cover the following wishlist items in Iteration 2 when the source audit supports them; move any item needing missing events into the instrumentation workstream.

| Items from `idea.md` | Existing candidate source and remaining work |
| --- | --- |
| DAU, WAU, MAU; DAU/MAU; WAU/MAU | Greptime account/page events, after an agreed activity definition. Aggregate unique account IDs over defined windows; show a missing ratio when MAU is zero. Latest account timestamps cannot reconstruct past active sets. |
| Daily / 2–4 times weekly / weekly / less often | Activity history with a reviewed rule for distinct active days versus session counts; last-active snapshots cannot establish frequency. |
| Activity by job position and unit | Activity events joined to a reliable organizational mapping. Iteration 1 shows current system roles/organisms/directions under their actual labels, without claiming position/unit activity. Decide whether historical grouping uses current or event-time membership. |
| Sessions per person per week; session duration | Session-start events exist, but page/heartbeat events do not carry a common session ID. Audit attribution first; exact duration needs session correlation and an idle/end rule, rather than counting heartbeats as sessions. |
| Generated report counts by period/type/author; generation latency | `report_history` and legacy `log_users_report_generation`, subject to coverage reconciliation and retry/rerun semantics. Add real date-range aggregation; do not scan every paginated admin row or count downloads as generation. |
| Login success rate; failure reasons; attempts by deleted/nonexistent users | Existing request outcomes and failure logs are candidate sources. Correlate password/Delta/2FA stages into completed attempts; an HTTP 200 or issued 2FA challenge is not necessarily a successful login. Validate retained failure identifiers before separating unknown/deactivated accounts. |
| Time from first failed attempt to success; lost after failed login | Correlated authentication outcomes plus an agreed abandonment window. Missing success after the window is a metric definition, not proof of a permanent loss. |
| Registration to first login; new accounts that never logged in | Account creation plus a complete successful-login history from a known coverage start. `lastActiveAt` cannot supply first-login time or distinguish users who never signed in. Mark older accounts unknown when history is incomplete. |
| Monthly churn; 30/90-day cohort retention; returning users | Complete qualifying-action history and an agreed cohort/return window. Expose only mature cohorts; do not substitute current account deactivation status for engagement churn. |
| Last action before inactivity / before stopping logins | Ordered action history and a definition of the inactivity window. Existing page-level events may support “last observed page”, but cannot identify arbitrary button actions. |
| Messenger-to-Echo bot delay; raw-data-to-report delay | Message timestamps and ingestion/creation timestamps are candidates. Confirm clock/time semantics, source coverage, and a stable raw-data → report relationship before calculating delay. |
| Direct / Signal / WhatsApp report distribution | Audit ingestion provenance and the meaning of “донесення” versus a generated report. Do not equate all messages with reports or classify channels from names. Aggregate by explicit source metadata. |
| Weekly active contributors including bots; bot authors whose Echo accounts are inactive | Messenger author-to-login identity mapping plus qualifying contribution events and account status. A profile association is a candidate mapping, not proof every contributor has one; deduplicate web/bot identities and report unmapped authors separately. |
| Request error percentage | `activity_details.response_status` and timings in Greptime. Define request scope, denominator, error classes, host, and period; request error rate is separate from uptime and user task success. |
| Notification delivery and delay | Audit notification receipts and `messenger_alert_delivery` timestamps/statuses. Distinguish queued, sent to transport, delivered to device, and read; a `sent_at` value alone proves only the recorded transport stage. |

## Missing events, integrations, and product definitions

- [ ] Handle the remaining wishlist with explicit instrumentation/source work. Agree event definitions and ownership before selecting schemas or APIs; do not add blank or fabricated Iteration 1 charts for these metrics.

| Items from `idea.md` | Required evidence / product decision |
| --- | --- |
| Accounts deleted during a period | Timestamped account deactivation/permanent-deletion audit, including retained tombstones and the distinction between those operations. Current flags provide no deletion period. |
| UI interaction counts; misclicks; back navigation; button usage and unique users; rage clicks | Stable feature/control event IDs, distinct-user denominators, navigation context, and reviewed misclick/rage-click heuristics. Backend request counts and page heartbeats do not establish UI interactions. |
| Weekly login-support requests; top reasons (VPN, certificate, browser, password, device, frontline conditions); resolution time; repeated contacts | A support source with account linkage, opened/resolved times, and structured reason categories. Application login logs cannot establish support contacts or their resolution. |
| Failed connections uploaded later from the device | Client-side offline recording, bounded retry/deduplication, occurrence and upload timestamps, and a safe event schema. Server logs cannot observe requests that never arrived. |
| Seven-day activation; time to first key action; onboarding drop-off | Rada/product owner chooses the key action and ordered onboarding steps; capture qualifying actions and compute only fully observed seven-day cohorts. First-login metrics alone do not measure activation. |
| Which features people try | Rada/product owner supplies the feature list, eligible audience, and qualifying use event. Measure distinct users and adoption within that audience, not just clicks by one heavy user. |
| Report creation to recipient's first view: median/p90; reports no recipient opened | Explicit report-recipient identity, delivery/availability time, and first-view receipts. Loading an inbox or downloading a generated report does not prove the intended recipient opened the report. Define the observation window and unopened denominator. |
| Important reports without a reaction: no view, reply, or forward | A shared report/recipient identity plus importance, view, reply, and forwarding events and a reaction deadline. Define what qualifies as a reaction. |
| Page load time | Browser navigation/render/readiness timing with an agreed “ready” point; backend response duration covers only part of the experience. |
| Messages the bot did not pick up | Upstream expected-message inventory or sequence/cursor reconciliation against received messages. Missing messages cannot be counted from received messages alone. |
| New people added by colleagues | Retained creator/referrer identity on account creation or an equivalent audit source. Confirm referral meaning; do not infer a referrer from the account's current organism. |
| System availability | Independent checks over a defined service window and an agreed availability target; request logs cannot establish availability during periods with no traffic. |

- [ ] For future schema/API work, keep backend types in Rust and use `just gen-front`; add new SQL migrations only where needed, follow comparable migrations, and perform the required analytics-impact/catalog checks against the selected base branch. Plan retention and coverage cutover explicitly; do not manufacture historical values for events that were never collected.
- [ ] Before any staging/production deployment or mutation, finish local implementation and validation, then request explicit approval naming the target, commands/operation, and expected impact, as required by `AGENTS.md`. This plan authorizes no environment changes.

