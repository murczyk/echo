# Pivnich release comparison and repeated unit scans (#3780)

29 October 2026. Follow-up to iterations [12](../iteration12/findings.md),
[13](../iteration13/findings.md) and [14](../iteration14/findings.md), on branch
`3780-pivnich-iteration15` from `stable` at `c8cd0f079`. Investigation was
read-only on `echo-pivnich` and its paired analytics host. No deployment,
configuration, schema, data, cache, counter or health metadata was changed.
Sanitized evidence is in [measurements.json](measurements.json).

## Release comparison

The old package was `0.1.1~rc.202610261229-1` (`3d7eb3e82`). The user's deployment
installed `0.1.1~rc.202610281539-1`; the API started at 09:06:23 UTC and workers
at 09:06:55. Binary inspection confirmed the scoped-source-search and source
admission markers. The release includes other features and migrations besides
the iteration 12–14 changes; this was not an isolated #3780 rollout.

The selected HTTP routes are Analysis paths, `/api/rer-importer/get-inbox%`,
and network group activity. Both public and Tailscale hostnames are included.
Counts deduplicate retained response events by request ID within path/status.
Native counts cover all `echo_gateway` queries, independently of HTTP scope.

| UTC interval | HTTP responses | HTTP 503s | Native successes | Native shared-user memory failures |
| --- | ---: | ---: | ---: | ---: |
| 08:40–08:50, old release | 11,063 | 151 | 7,429 | 485 |
| 08:50–09:00, old release | 11,251 | 299 | 7,355 | 602 |
| 09:10–09:20, new release | 11,041 | 62 | 8,105 | 261 |
| 09:20–09:30, new release | 11,168 | 288 | 7,425 | 445 |

These samples do not establish a global increase in failure rate caused by the
release, nor recovery. Filters, users, cache state and background work differ.
The old release also omitted some deadline completions, as documented in
iteration 12, so its retained responses are not a complete denominator.
No 500 response was retained in these selected routes; operator submission
errors below are outside this scope.

Some route latencies increased in these samples: between 08:50–09:00
and 09:20–09:30, mean completed inbox-page response time increased from 1,121
to 1,935 ms, and network activity from 27,272 to 34,540 ms. The latter had
12 and 10 retained 503s respectively; the new 60-second HTTP guard now also
covers these routes. These are uncontrolled response cohorts, not paired
executions with identical filters.

## Native work and a duplicate predicate

The heaviest native count families both before and after deployment read
unit-link history. One direct-unit count shape ran 48 times before and 117
times after in the two comparison intervals. Its accumulated duration rose
from 465 to 1,001 seconds while peak query memory remained about 270 MB.
That is more executions of an existing expensive shape, not evidence that
the latest release doubled each execution's work.

The actual native query applied the same unit membership twice: once to the
message ID and once to the joined inbox ID. Both outer tables already have
the same explicit message-ID range. The local builder first adds membership
through `apply_resolved_analytics_unit_filters_with_ids`, then adds an
equivalent second predicate when no named units are selected. The previous
release already contained both predicates.

Plain native plans confirmed two reads of `echo_cdc.sigint_inbox_item_unit`;
removing either redundant predicate leaves one. Six sequential read-only
probes compared the captured query and both single-predicate variants, in
forward and reverse order. Every probe used four threads, an eight-second
execution budget and a 1-GiB query memory cap under an administrative account.
This avoids interpreting the gateway user's shared-limit victims as per-query
work measurements. No HTTP request was replayed and no log flush was requested.

The completed baseline read 310,665,044 logged rows in 6,748 ms, with
254,809,715 bytes of tracked memory. An earlier baseline timed out at 8,006 ms.
The retained-inbox-predicate variant read 155,388,282–155,398,515 rows in
6,139–7,023 ms, using 153,430,451–165,626,925 bytes. All completed variants
returned the same count and earliest timestamp. Logged rows include CDC/current
state processing and are not unique messages.

Removing the duplicate halves the observed read work and lowers tracked memory
for this sample. It still scans substantial history; these timings do not
establish a whole-request or concurrent-load improvement. No lower concurrency,
larger memory budget or resnapshot was justified or applied by these probes.

## Health-probe amplification

At 09:12:09 and 09:18:53, the replicated heartbeat queries failed with the same
8.80-GiB shared-user memory exception. They read two/three rows and tracked
39,689/38,088 bytes themselves. The probe immediately wrote `healthy=false`,
causing otherwise eligible requests to enter bounded PostgreSQL fallback.

The 09:12:09 failure recovered at 09:12:32. This is a resource failure while
reading replication evidence, not proof that the mirror stopped. It differs
from the earlier deployment transition: the mirror was paused/snapshotting
around 09:08–09:09 and passed its end-to-end check at 09:10:03.

Iteration 14 already distinguished shared-user memory pressure from individual
network query memory failures. Iteration 15 therefore preserves the existing
resource budgets and freshness guard, while extending the existing delayed
heartbeat policy to narrowly recognized shared-user memory/concurrency errors.
Implementation and validation are recorded [separately](implementation.md).

## Separate release regression: reply-thread serialization

Both reply migrations were first applied at 09:06:18 during this deployment.
The thread migration installs an exclusive transaction-level advisory lock
named `message-reply-threads`, used explicitly by source reconciliation and
by triggers on reply updates. Even unstaging a new message can reach it through
the endpoint-change trigger before inbox parsing finishes.

In retained 09:08–09:15 application logs, 58 ingestion retry events affected 56
distinct queued items, and an operator submission logged an internal-server
error with the same reply-lock context. At 09:18:24, seven sessions waited
behind that global lock; its holder was idle in a transaction after a parsing
query. All 56 observed failed queue IDs had left the queue by 09:20:36.

This is a new release-specific serialization path and a plausible contributor
to source latency, independently of native memory pressure. The prepared follow-up replaces this global coordination with locks on the
affected connected messages and source receipts, with dedicated concurrency
regressions; see [implementation.md](implementation.md). No reply migration or
worker restart has been applied remotely.
