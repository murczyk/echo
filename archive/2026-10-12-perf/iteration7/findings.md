# Iteration 7: stabilize ClickHouse outages (#3780)

Read-only Skhid investigation on **24 October 2026**. The source runs package
`0.1.1~rc.202610240952-1`; its API started at **11:34:59 UTC**. Pivnich is outside
this iteration because its latest fixes have not been deployed. REO report
optimization is deferred at the user's request. No remote application, schema,
configuration, service, queue or analytics metadata was changed during this
work. Diagnostic SELECTs used explicit time, memory and thread limits.

## Confirmed improvements and remaining incident

Between 11:20 and deployment, the old unfiltered native search fingerprint
recorded 45 failures. Between deployment and 11:51, 44 native text searches
applied filtering and completed, with no recurrence of that unfiltered shape.
Both analytics gateways had fresh healthy heartbeat records, complete attachment
history and active source replication slots when inspected.

At **11:47:20–11:47:23**, five unit-filtered inbox candidate reads failed with
native error 241. Total-server RSS reached **18.03 GiB** against the **17.6-GiB**
server limit. Individual victims tracked **3.23–4.74 GiB** and read
**86.8–161.8 million** raw rows. A sampled profile recorded 23,880,081 join-build
rows and 26,295,864 preallocated hash elements. These are tracked query memory
and versioned raw reads, not current logical row counts or physical disk bytes.

The selected-unit semi-join filtered inbox rows, while the message side could
still build a hash table over nearly the entire history before joining them.
Duplicating the existing unit predicate onto the equal message ID filters that
input first. Ordinary header/network-unit OR direct-ID semantics must remain
unchanged, so the extra predicate applies only without the ordinary-unit branch.

The five errors opened the shared inbox analytics circuit and caused **49
completed inbox fallbacks**: five `analytics_error` and 44 `circuit_open`, with
a maximum whole inbox duration of **17,106 ms**. No further application-user
native exceptions had appeared by the later 12:10 inspection. Diagnostic queries
subsequently generated their own bounded query-memory exceptions and must be
excluded from production incident counts.

The gateway ClickHouse user had no explicit per-query, aggregate-user, thread
or concurrency settings. Server-wide memory protection selected victims only
after unrelated work had already shared the pressure. Gateway-specific limits
are therefore part of this stabilization, alongside the query change.
The finished-query overlap sweep observed a peak of 17 concurrent reads;
implementation keeps concurrency headroom at 32 rather than selecting a lower
untested ceiling.

## Messenger failures

Post-deployment source logs contained one deadlock, two lock timeouts and six
idle-in-transaction terminations in the inspected window. Two messenger
snapshots created on 20 October had each reached **176 attempts**; their latest
errors identified idle transaction termination. Both bodies were 12,836 bytes.
These are existing stuck snapshots, not evidence of a newly introduced retry bug.

Callsign highlighting tokenized the body once, then sent a separate lexeme HTTP
request per callsign while the import transaction remained open. The existing
batch endpoint uses the same morphology function in the same input order.
Batching removes those cumulative round trips without increasing timeouts or
discarding messages. The local tests use the production endpoint functions with
spaCy's Russian tokenizer and pymorphy3; they do not exercise a production model
deployment or prove completion of those two live snapshots.

The captured deadlock involved insertion into `palitra_highlight_worker_job`
and insertion into `sigint_inbox_item_point_token`. The highlight worker claims
the queue job before writing tokens; reprocessing invalidated tokens before
enqueueing the job. Reprocessing now acquires the queue job first, preserving
the transaction and normal retries. A two-connection database regression checks
that a highlight worker can finish while reprocessing waits, and that the
replacement job remains queued afterward.

## Other observed behavior and scope limits

The host-scoped HTTP window **11:35:30–12:05:00** had no retained 5xx responses.
There were successful slow reads, including a 27,989-ms inbox count at 11:49:30
and an 8,916-ms inbox page at 11:59:31. Long-poll durations are intentional and
are excluded from the slow-read assessment.

During the investigation a different source-only search workload produced
**33 retained 503s between 12:06:53 and 12:09:58**, involving groups, senders,
tags, frequencies, counts and inbox pages. Representative SQL contained twelve
OR text alternatives and negative quoted predicates; PostgreSQL canceled source
statements while ClickHouse had no new application exceptions. These unsupported
quoted predicates use `query_policy`; this iteration does not claim to fix
their source query plans or change that routing policy. Keep this as separate
search work after the outage and messenger canary.

Repeated media-summary lease-loss errors had no pending/failed summary jobs at
inspection. Missing-AOR consistency warnings and an Iggy loop warning also
appeared; the Iggy loop already sleeps outside its measured work interval.
These logs do not establish another interactive failure or an actual busy loop.

Results, diagnostic comparisons and rollout gates are recorded in
[implementation.md](implementation.md) and [measurements.json](measurements.json).
