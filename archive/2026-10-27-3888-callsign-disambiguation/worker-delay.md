# AI worker delay investigation

Read-only investigation of `echo-pivnich` and `echo-skhid`, 2026-10-27 UTC.
Related callsign recommendations: [README.md](README.md).
Recorded measurements: [worker-delay-evidence.json](worker-delay-evidence.json).
The later approved queue clear, Luna switch, and subsequent gateway rate-limit
failure are recorded in [luna-switch.md](luna-switch.md).

## Finding

The callsign workers are running and attempting jobs, but useful processing is
effectively failing in the observed window. This is not a stopped process or
an unchanged queue head. Jobs fail at AI extraction and are rescheduled behind
a backlog of approximately 1.17 million jobs on pivnich and 2.04 million on
skhid. Increasing the iteration counter therefore does not demonstrate recovery.

There is a confirmed current provider authorization problem on both servers.
Settlement and position jobs record this response:

```text
HTTP 401 Unauthorized
Authentication Error, model 'glm-5.3' is not in this grant's allowlist ['gpt-luna']
```

On each server, callsign, settlement, and position workers select the same
GLM-5.3 engine row and government gateway. Callsign failures occur at
`ai_callsign/mod.rs:539`, where the AI extraction result is propagated.
The shared authorization failure is therefore the leading explanation for
current callsign failures. Their individual HTTP responses cannot be recovered
from the stored errors because the callsign worker discarded the error chain.

Earlier retained skhid metrics show many approximately 300-second iterations,
matching the configured AI request deadline. Earlier settlement errors also
include HTTP 429 with no available GLM deployments, and empty AI responses.
The present 401 is not evidence that authorization caused every day of the
historical backlog; the incident has evidence of multiple provider failure modes.

## Measured queue behavior

The counter interval was approximately 14:47:42–14:51:50 UTC, about 248 seconds.
Queue depth comes from `pg_stat_user_tables.n_live_tup` and is an estimate.
Insert, update, and delete deltas are PostgreSQL table counters, not application
success counters; enqueue conflicts can also update rows.

| Measurement | echo-pivnich | echo-skhid |
| --- | ---: | ---: |
| Estimated pending jobs at interval end | 1,169,826 | 2,035,290 |
| Oldest due job creation time | Oct 11, 15:34:55 | Oct 10, 09:04:40 |
| Age of oldest due job | 15 days 23 hours | 17 days 5 hours |
| Inserted queue rows | 255 | 426 |
| Updated queue rows | 119 | 124 |
| Deleted queue rows | 2 | 0 |
| Net queue growth | 253 | 426 |
| Observed insert rate per minute | 61.7 | 103.2 |
| Observed delete rate per minute | 0.48 | 0 |

Deletions are only an upper bound on successful processing: the worker also
deletes jobs for deleted messages and exhausted retries. No success throughput
can be inferred from the iteration count or those two deletions.

Specific callsign jobs establish actual failures rather than only counter
correlation:

- Pivnich `34172427` was due with zero attempts at 14:47:42; by 14:49:51 it had
  one attempt and a retry time of 14:47:47.
- Skhid `42876113` likewise changed from zero attempts to one, with a retry
  time of 14:47:49.
- Both stored only `at wdintel-rs/src/ai_callsign/mod.rs line 539 column 12`.
  Later sampled failures had the same error.

Both services had been active since approximately 10:24 UTC, with zero systemd
automatic restarts. Both callsign advisory leases were held by live database
sessions whose most recent heartbeat query was only seconds old. The next-job
query used `ai_callsign_worker_job_next_attempt_idx` and took 0.192 ms on
pivnich and 0.081 ms on skhid in bounded production plan checks. Queue-head
selection is not the observed bottleneck.

## Why the failure appears silent

The relevant implementation is in
[worker.rs](../../wdintel-rs/src/ai_callsign/worker.rs),
[client.rs](../../wdintel-rs/src/ai_engine/client.rs), and
[worker_watch.rs](../../wdintel-rs/src/utils/worker_watch.rs).

1. `process_next` catches extraction errors and passes `error.to_string()` to
   `fail_job`. The outer source-location context replaces the useful error
   chain in persisted `last_error`. The reparse worker uses the same lossy
   formatting in its failure path.
2. `fail_job` does not log attempts 1–7. It logs only the eighth failure, then
   deletes the queue row. Ordinary failures are therefore absent from the
   worker error log and terminal evidence is not retained in a failed queue.
3. On failure, `next_attempt_at` becomes current time plus the retry delay.
   Selection sorts all due work by that timestamp. A retry due in seconds
   still waits behind the millions of older first attempts; the eight-attempt
   limit does not ensure a prompt visible failure.
4. `process_next` reports that it processed work even when it only rescheduled
   a failed job. Loop metrics count iterations and duration, without recording
   successful completions, last success, oldest pending age, or backlog growth.
5. The worker settings UI exposes enabled state and engine selection, without
   queue health or failure information. A live lease and enabled checkbox
   cannot detect this outage.
6. The AI client refreshes a token and retries once on HTTP 401. Repeated
   allowlist rejection does not activate the GLM cooldown, which handles 429.
   Hundreds of token-renewal log entries were present during inspection;
   successful token acquisition does not establish model authorization.
7. Pivnich journald also reported suppressing 95,332 and 162,330 background
   worker messages. High-volume unrelated logs further weaken visibility;
   existing callsign retry paths already omit their own error messages.

The callsign worker processes one job at a time under one advisory lease,
interleaving reparse work in the same loop. A single 300-second AI request
blocks subsequent jobs for that duration. The four-request constant used by
the admin evaluator does not make the background worker concurrent.

## Suggested recovery order

1. Resolve the current provider/model authorization mismatch. Restore access
   to `glm-5.3`, or verify and select a supported replacement with appropriate
   extraction quality. The response's `gpt-luna` allowlist entry does not prove
   that the configured `gpt-6-luna` engine identifier is permitted. Both servers
   also have a Gemma router engine configured for callsigns, but its availability
   and output quality were not tested. Changing the shared GLM engine row would
   affect all three workers and other users of that engine.
2. Preserve complete, bounded error chains and log the first failure with
   worker, engine, job ID, attempt, elapsed time, and next retry. Aggregate or
   rate-limit repeated identical errors without hiding their count or the
   latest cause. Apply this to ordinary and reparse jobs.
3. Expose queue depth, oldest first-attempt and retry ages, arrival and success
   rates, last successful completion, in-flight stage/age, and provider error
   classes. Alert on stale success and growing lag even when the process and
   heartbeat are healthy. An independent observer must detect stuck awaits.
4. Add provider-level suspension/backoff for persistent authorization failures
   and outages, shared across relevant workers. Bound each job's total duration
   and external stages; avoid repeatedly refreshing valid tokens for model
   entitlement errors. Keep recoverable work and terminal failure evidence.
5. After provider recovery, schedule fresh work, retries, and historical work
   with explicit fairness. Do not let all new messages wait behind the full
   backlog or let retries wait days after their nominal retry time. Preserve
   idempotency, manual overrides, stale-body checks, and cancellation behavior.
6. Measure successful service capacity before choosing bounded concurrency.
   Use safe per-job claims and a shared provider request budget; merely starting
   more workers behind the existing global lease cannot increase concurrency,
   and unbounded requests can worsen a provider outage. Plan historical draining
   only after new work meets its latency target and measured capacity exceeds
   arrivals.

A restart alone does not repair an allowlist rejection or erase this backlog.
No production services, credentials, engines, prompts, or queue rows were changed
during investigation. Any recovery operation must first name the exact target,
change, expected impact, and validation, and obtain the approval required by
the repository instructions.

## Validation for a future fix

Use local functional regressions to cover the first failed request retaining
its cause, repeated 401 and 429 responses, a request deadline, fair retry/new-work
selection, duplicate claims, durable terminal failures, and recovery after a
provider becomes usable. Validate ordinary and reparse paths.

For an approved production recovery, verify actual successful outputs and a
recent last-success timestamp, absence of continuing model-authorization
errors, fresh-message latency, and success rate versus arrivals over a measured
interval. Track backlog reduction separately from attempted jobs, skipped
messages, and deleted terminal failures. Historical cleanup or reprocessing
must be separately scoped; do not discard the queue to make its metrics green.
