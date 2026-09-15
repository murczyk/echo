# Echo Pivnich performance investigation and fixes

Investigation date: 2026-09-15 UTC.

Scope: production was inspected read-only through `echo-pivnich` and the
analytics host. No production data, process, service, or configuration was
changed. The fixes below exist in this worktree and still require review,
deployment, and production verification.

## Executive conclusion

The analytical database was not offline. ClickHouse, its PostgreSQL gateway,
PeerDB, and the required services were running and analytics requests continued
to succeed. The incident was an overload cascade:

1. Duty's one-second exact-count fan-out and unconstrained application
   concurrency generated expensive ClickHouse work.
2. Source-side UUID backfill and network maintenance concurrently loaded
   PostgreSQL and produced replication/WAL pressure.
3. A heartbeat was not visible through ClickHouse within the probe's 45-second
   timeout. The probe immediately marked analytics unhealthy even though the
   application explicitly allowed 90 seconds of replication age.
4. Every analytical operation rejected the shared health state. Those
   rejections incorrectly opened independent 30-second query circuits.
5. Requests then fell back to PostgreSQL. Production has zero configured
   read replicas, so `env.replica()` resolves to the primary database.
6. The primary was already handling an unthrottled UUID backfill and duplicate
   synchronous/asynchronous network `last_seen_dt` recalculation.

The result was slow analytics while it remained online, followed by a burst of
slow primary-PostgreSQL fallbacks. It was not a clean analytical-tier outage.

## Production evidence

- Analytics health succeeded through `10:13:48` UTC.
- A probe started at `10:14:03` and timed out at `10:14:50`; the next one
  timed out at `10:15:52`.
- Replication recovered without restarting a service. A probe started at
  `10:16:07` and succeeded at `10:16:26`.
- Application operations remained `circuit_open` for their per-operation
  cooldown after health recovered.
- The recovered logical slot was only about 5 MiB behind, which confirms a
  transient lag spike rather than a persistent mirror outage.
- Configured limits were: 45-second probe timeout, 90-second application
  freshness, 30-second analytics query timeout, and 30-second circuit cooldown.
- Source and analytics host load averages were about 170 and 165 respectively;
  ClickHouse used roughly 6.4 CPU cores. Memory and storage were not exhausted.
- In one 20-minute ClickHouse report:
  - two common exact-count shapes ran about 68 and 141 calls/minute, scanned
    about 37.1 and 29.3 billion rows, and read about 1.81 and 1.43 TiB;
  - a common candidate shape ran about 329 calls/minute and scanned about
    2.5 billion rows;
  - count fragments scanned roughly 92-126 million rows and reached 17-23
    seconds.
- Page-route logs showed:
  - Analysis analytics-hybrid reads averaged about 4.7 seconds and reached
    17.1 seconds; its PostgreSQL fallbacks averaged 0.4 seconds and reached
    2.1 seconds in the sampled window.
  - Duty analytics reads averaged about 2.4 seconds and reached 17.5 seconds;
    its PostgreSQL fallbacks averaged 1.7 seconds and reached 38.8 seconds.
- PostgreSQL has no configured application replicas on this instance.
- PostgreSQL runtime limits are a 30-second statement timeout, 3-second lock
  timeout, and 120-second idle-transaction timeout.
- At approximately `10:43`:
  - invalidation queue: 206,785 old, 73,586 recent, and 36 unassigned pending;
  - 193,036 old and all 73,586 recent rows had a non-null `started_at`;
  - direct `network_freq_last_seen` queue: 222 queued and one running.
- `pg_stat_statements` attributed 51,291 exact network-frequency
  `last_seen_dt` updates to 121,383.6 seconds total execution time
  (2,366.6 ms mean, 36,513.7 ms maximum).
- The invalidation worker had issued about 12.9 million per-row “started”
  updates and 12.45 million per-row completion updates.
- Pending networks included 336,530, 206,143, 180,867, and 168,945 linked inbox
  rows. Multiple frequencies of the same network were queued separately, so
  each task repeated a full network-history scan.
- A UUID backfill was active with `--batch-size=10000`; a sampled batch update
  had already run for 26 seconds.
- A lock snapshot did not show a permanent blocker. The recurring failure was
  a 3-second `55P03` lock timeout during invalidation finalization.

## Fixed findings

- [x] Analytics health flaps prematurely forced PostgreSQL fallback
  - Root cause:
    - The 45-second heartbeat visibility timeout immediately wrote
      `healthy=false`, contradicting the application's 90-second freshness
      contract.
    - A replication-health rejection was treated like an analytics query
      failure and opened a 30-second per-operation circuit.
  - Fix:
    - `check-analytics-health.sh` now records delayed heartbeat/LSN detail
      without overwriting the last successful `healthy` and `checked_at`
      values. Consumers naturally reject the tier only when that success is
      older than their configured freshness budget.
    - Hard probe failures still fail closed immediately.
    - Replication-health rejection now has a typed error. It does not open a
      query circuit, and a half-open attempt is released immediately so the
      next request can retry as soon as health recovers.
  - Verification:
    - `deploy/clickhouse/tests/test-analytics-health-probe-timeout.sh` proves
      that a delayed heartbeat preserves the last successful health record.
    - Five half-open/circuit tests pass, including
      `replication_health_failure_releases_half_open_circuit`.

- [x] Analytics inbox candidates and exact counts had severe tail latency
  - Root cause:
    - The analytics pool inherited the web PostgreSQL pool size of 50, allowing
      one process to submit far more concurrent gateway/ClickHouse work than
      the measured query cost can sustain.
    - Timestamp-to-ID scope bounds were recomputed repeatedly. Analysis only
      coalesced calls while a query was in flight and discarded the successful
      value immediately; inbox candidate/count construction had no bounds
      result cache.
  - Fix:
    - Analytics has a dedicated configurable `max_connections`, defaulting to
      8. The deployment example documents the value.
    - Successful Analysis message-ID scopes are cached for five seconds, with
      in-flight coalescing retained and a 2,048-entry bound.
    - Inbox message-ID bounds are cached and singleflight-coalesced per stable
      pool/sort/range/source key for five seconds with the same entry bound.
    - Failed lookups are never retained.
  - Verification:
    - `analytics_message_id_scope_caches_successful_result` proves a completed
      result is reused.
    - `analytics_inbox_bounds_cache_coalesces_and_reuses_success` proves
      synchronized feed requests share the bounds lookup and its result.
    - Rust check and strict Clippy pass.
  - Expected effect:
    - At most eight concurrent analytical queries per application process and
      substantially fewer repeated bounds scans. Actual production P95 and
      scanned-row reduction must be measured after deployment.

- [x] `/rer-duty-neo` polled exact counts every second
  - Root cause:
    - Each of up to four feeds independently polled
      `/api/rer-importer/get-inbox-count` every second while the backend cache
      only changes every five seconds.
  - Fix:
    - The persisted setting, API output, backend write path, admin UI, and Duty
      client now enforce a five-second minimum, including legacy rows that
      contain `1`.
    - Inbox-change events trigger an immediate coalesced poll, throttled to one
      per five seconds, so the slower safety interval does not remove
      event-driven responsiveness.
    - Existing visible-message event refresh remains in parallel with that
      count/newer-message poll.
  - Verification:
    - `rer_duty_poll_interval_matches_count_cache_freshness` proves the backend
      clamps legacy one-second values.
    - The focused Duty suite passes 19/19, including the five-second clamp and
      an event for a non-visible message triggering the poll.
    - Prettier and the complete `just build-front` build pass.

- [x] PostgreSQL fallback bursts overloaded the transactional database
  - Root cause:
    - Correctness fallback transferred analytical joins/counts to
      `env.replica()`, but this deployment has no replica, so that connection
      is the primary.
    - Shared health rejection caused many independent operations to fall back
      together.
  - Fix:
    - Incident-driven generic fallbacks are protected by a process-wide
      eight-request semaphore. Waiting longer than 250 ms returns a retryable
      503 instead of queueing more expensive work on PostgreSQL.
    - Analysis exact-count PostgreSQL paths use the same capacity boundary.
    - Query-policy and analytics-unconfigured generic PostgreSQL routes are not
      classified as incident fallbacks.
    - The health/circuit fixes remove false fallback bursts at their source.
  - Verification:
    - `fallback_capacity_only_limits_analytics_incident_routes` passes.
    - Existing PostgreSQL runtime-timeout mapping remains covered and returns a
      retryable user-visible service error.

- [x] Network invalidation finalization failed on frequency-row locks
  - Root cause:
    - Finalization recalculated Redis network stats and synchronously updated
      `sigint_network_freq.last_seen_dt`, contending with the direct
      recalculation worker for the same rows.
    - Any failure made the no-fail worker sleep for ten minutes.
  - Fix:
    - Invalidation-driven Redis stats rebuilds no longer write
      `last_seen_dt`; they enqueue the exact direct calculation instead.
      Other intentional stats paths retain their existing synchronous update.
    - Error retry is reduced from 600 seconds to 30 seconds.
    - Any failed start, processing, or finalization step best-effort resets all
      unfinalized tasks accumulated by that worker pass. The reset only clears
      rows whose `started_at` still matches that attempt, making retry state
      visible without erasing a newer worker's marker.
  - Verification:
    - Rust check and strict Clippy pass.
    - Existing exact-last-seen behavior passes against a dedicated restored
      test database.

- [x] Network `last_seen_dt` had duplicate synchronous and asynchronous writers
  - Root cause:
    - The invalidation finalizer performed an exact synchronous write and then
      enqueued the same exact asynchronous write.
  - Fix:
    - The asynchronous direct queue is now the single exact writer for
      invalidation work.
    - Existing incremental writes outside invalidation are unchanged.
    - Frequency advisory locks remain in place for writer serialization.
  - Verification:
    - `invalidated_latest_message_reveals_previous_network_activity` passes,
      proving deletion still reveals the correct earlier activity timestamp.

- [x] The invalidation backlog was large and `started_at` was misleading
  - Root cause:
    - `started_at` represented an attempted batch, not durable ownership. A
      failed finalization left every row marked started indefinitely.
    - Start and completion were written one row per SQL statement, accounting
      for millions of avoidable round trips.
  - Fix:
    - Start and completion state is updated in bounded bulk statements.
    - Failed batches clear their attempted-start marker for an honest retry
      state.
    - Removing the duplicate frequency lock and shortening retry removes the
      observed drain blocker.
  - Verification:
    - Compilation/Clippy validate the batch paths; post-deploy queue drain is
      intentionally an operational check below because this worktree was not
      deployed to production.

- [x] The direct network recalculation queue churned on repeated history scans
  - Root cause:
    - A task represented one frequency, but many pending frequencies belonged
      to the same large network. Each task independently scanned that network's
      full inbox-link history.
  - Fix:
    - Claiming one `network_freq_last_seen` task now serializes at network
      scope, locks up to 500 same-network tasks, locks their frequency rows in a
      stable order, computes every target in one grouped history scan, and
      deletes the completed task batch atomically.
    - A second worker that had already claimed a task detects that the first
      worker completed it and exits without repeating the scan.
    - Per-run task capacity increased from 100 to 500; the existing 50-second
      run budget still bounds source load.
  - Verification:
    - `last_seen_tasks_for_one_network_are_recalculated_in_one_batch` passes
      against a database restored from the standard test dump.
    - The test proves two tasks become two correct timestamps and zero queued
      tasks after one worker pass.

- [x] UUID backfill competed with interactive and worker traffic
  - Root cause:
    - The default and active override were 10,000 messages per transaction.
      Each batch updates the parent plus many linked tables, creating long
      write transactions and bursty WAL.
  - Fix:
    - Default batch size is now 500.
    - Batch size is hard-bounded at 1,000; zero or a larger value is rejected
      before opening a database connection.
    - A configurable `--pause-ms` is applied after every committed batch and
      checkpoint write, defaulting to 250 ms.
    - The existing durable checkpoint remains unchanged.
  - Verification:
    - `uuid_backfill_batch_size_is_bounded` passes.
  - Rollout warning:
    - The currently observed old binary/process using
      `--batch-size=10000` is unaffected until stopped. With the new binary,
      that argument is intentionally rejected; restart it with the default or
      `--batch-size <= 1000` and the default pause.

- [x] Inbox diagnostics collapsed distinct fallback causes
  - Root cause:
    - The candidate loader returned only `Unavailable`, discarding the
      routing reason supplied by the lower analytical fallback layer.
  - Fix:
    - Analytical reads can now return a typed route outcome.
    - Page diagnostics preserve `unconfigured`, `query_policy`,
      `circuit_open`, `analytics_unhealthy`, `analytics_error`,
      `analytics_timeout`, and `analytics_empty_scope` separately.
  - Verification:
    - `analytics_read_outcome_reports_unconfigured_postgres_path` passes on
      the dedicated restored test database.

## Ruled out or contextual findings

- The analytical database itself was not down; the incident combined slow
  queries with transient replication visibility lag.
- There was no persistent PostgreSQL blocker in the sampled lock snapshot.
- Memory and disk exhaustion were not observed.
- The invalidation pickup query was not the measured bottleneck. Although its
  partial indexes are not ideal for every tag/timestamp shape, sampled pickup
  latency was small compared with exact last-seen scans, per-row status writes,
  and the ten-minute retry delay. No speculative schema migration was added.
- The UUID backfill correlates strongly with source/WAL pressure, but the
  available observations do not prove it alone caused the replication spike.
  The throttle is justified independently by its sampled 26-second batch and
  contention with interactive work.

## Local verification completed

- [x] `deploy/clickhouse/tests/test-analytics-health-probe-timeout.sh`
- [x] `cargo fmt --all -- --check`
- [x] `cargo check -p wdintel-rs`
- [x] `cargo clippy -p wdintel-rs --all-targets -- -D warnings`
- [x] Focused health/circuit, cache, fallback classification, UUID-bound,
  route-outcome, and network batching Rust tests
- [x] Existing last-seen deletion/reveal regression
- [x] `npx vitest run src/ts/react/routes/rer-duty-neo/useRerDutyFeeds.spec.ts`
  (19/19 pass; the isolated environment prints expected connection-refused
  noise for its absent localhost API)
- [x] Targeted Prettier formatting
- [x] `just build-front`
- [x] `git diff --check`

The repository's shared default test database is inconsistent: migration
`m20231226_134526_index_sigint_comment_signal_message_id` is recorded as
applied while table `sigint_comment` is absent. Database-backed regressions
were therefore run successfully against dedicated
`wd_test_codex_echo_performance_20260915`, restored from the repository's
standard test dump and migrated to the current catalog.

## Production rollout and verification (not performed)

- [ ] Review and deploy the application, frontend, and analytics health-probe
  changes together.
- [ ] Stop the old UUID backfill and resume its existing checkpoint with the new
  binary using the default batch/pause or an explicit batch no larger than
  1,000.
- [ ] Confirm the application analytics pool uses eight connections (or an
  explicitly reviewed lower value).
- [ ] Confirm delayed heartbeat probes preserve the previous success until the
  90-second freshness budget expires, while hard failures still mark unhealthy
  immediately.
- [ ] Watch `analytics_route` by exact reason, including
  `fallback_saturated`; verify false `circuit_open` cooldowns no longer
  follow replication-health rejection.
- [ ] Compare ClickHouse calls/minute, scanned rows, bytes, and P50/P95/P99 for
  Duty counts and candidate queries before/after.
- [ ] Verify `/rer-analysis` and `/rer-duty-neo` load normally with multiple
  active users and four Duty feeds.
- [ ] Track old/recent/unassigned invalidation counts and oldest age until they
  monotonically drain; verify failed batches show reset retry state.
- [ ] Track direct recalculation queue arrival/drain rate and
  `network_freq_last_seen` mean/max execution time.
- [ ] Confirm no recurring PostgreSQL `55P03` in invalidation finalization.
- [ ] Confirm primary PostgreSQL load, replication lag, and WAL stay acceptable
  while the throttled UUID backfill runs.
