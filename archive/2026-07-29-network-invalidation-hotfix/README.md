# Network invalidation load hotfix

Date: 2026-07-29

## Summary

Production network invalidation repeatedly rebuilt its task queue and
recalculated whole-day network statistics for each hourly task batch. The
hotfix preserves task scope, makes cleanup an inactive-worker emergency path,
and coalesces statistics recalculation by local date for each worker pass.

## Production evidence

Both `echo-kupiansk` and `echo-pivnich` repeatedly returned to the same 8,762
pending tasks: 961 recent tasks and 7,801 old tasks. Cleanup deleted task rows
while the recent worker was still processing them, causing
`RecordNotUpdated` completion failures before a new 365-day backfill recreated
the queue.

On `echo-pivnich`, approximately 34 hours of `pg_stat_statements` history
showed:

- 92,356 network-statistics query calls;
- approximately 1.896 billion rows returned;
- approximately 13.675 million ms of database execution time;
- invalidation scans processing approximately 49 million rows in 9.73 million
  ms.

A 16-second live sample included 30 statistics queries returning approximately
786,000 rows and using 4.16 seconds of database execution time. System load
was approximately 33-37 during the sample.

## Root causes

1. Cleanup compared the task-table count to
   `NETWORK_INVALIDATION_TASK_WAIT_SLEEP_SEC` (600) instead of
   `NETWORK_INVALIDATION_TASK_MAX_TASKS` (1,000,000).
2. Cleanup could delete tasks owned by an active worker.
3. Triaged tasks discarded `aor_id` and `group_master_key`, widening scoped
   work into global invalidation.
4. Each hourly message batch recalculated complete local-day statistics, so
   many batches rebuilt the same day repeatedly.
5. Cleanup used a blocking thread sleep inside async worker code.

## Hotfix

`wdintel-rs/src/sigint/network/etalon_calc/worker.rs` now:

- uses the one-million-task cleanup threshold;
- skips cleanup while any network invalidation worker or started task is
  active;
- uses asynchronous cleanup backoff;
- preserves AOR and signal-group scope when inserting triaged tasks;
- accumulates affected network scopes by local date while processing hourly
  message batches;
- recalculates each affected date once, promoting a date to all-network scope
  if any global task affects it;
- marks tasks complete only after their coalesced statistics recalculation
  succeeds.

## Local validation

- `cargo fmt --all -- --check`
- focused unit tests for date coalescing, network-ID merging, and promotion to
  all-network scope
- `cargo check -p wdintel-rs`
- hotfix-scoped clippy validation with unrelated repository-wide Rust 1.97
  baseline lint classes allowed

## Deployment

### `echo-kupiansk`

Deployed with:

```sh
just deploy-from-local --server echo-kupiansk
```

The recipe built the full frontend and release Debian package, installed it,
and verified `wdintel-rs.socket`, `wdintel-rs-bgworker.service`, and the
systemd-owned listener on port 8081.

Post-deploy observations:

- the recent and old workers triaged 961 and 7,801 tasks once;
- both workers advanced without replacing those task IDs;
- the recent worker completed all 961 tasks in approximately five minutes,
  including its coalesced statistics phase;
- no cleanup trigger, `RecordNotUpdated`, or invalidation worker failure was
  logged;
- both services remained active and observed system load was approximately 3.

### `echo-pivnich`

Before deployment, system load was approximately 34. The dominant
network-stat query had 46,437 calls and had returned approximately 1.98
billion rows in the available `pg_stat_statements` window.

Deployed with:

```sh
just deploy-from-local --server echo-pivnich
```

Post-deploy observations:

- the service resumed a 6,543-task old-worker backlog and advanced from 18 to
  171 started tasks during the main three-minute observation window;
- the four `pg_stat_statements` entries used by network-stat source loading
  remained exactly flat at 46,461, 46,459, 1,532, and 1,532 calls while the
  invalidation worker advanced;
- task IDs and creation timestamps stayed fixed after initial triage;
- `wdintel-rs.socket` and `wdintel-rs-bgworker.service` remained active with
  zero restarts;
- no cleanup trigger, `RecordNotUpdated`, or invalidation worker warning or
  failure was logged.

Immediate system load remained approximately 39 because the old invalidation
backlog and unrelated database work continued. The verification demonstrates
that per-hour full-day network-stat queries stopped; it does not claim that all
database load disappeared before the backlog drained.

The final cross-host check confirmed that both production hosts were running
the same packaged binary checksum, both services were active with zero
restarts, and neither host had network invalidation errors after deployment.
