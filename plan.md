# Plan: fix group stats recalculation lock timeouts

## Investigation summary

- `echo-skhid` bgworker was restarted at `2026-09-02 15:26:23 UTC`.
- Recent `wdintel-rs-bgworker` logs show repeated 3s `lock_timeout` failures on:
  `insert into group_stats_recalculation_task ... on conflict ((true)) where completed_at is null and started_at is null`.
- In a 3-minute sample around `15:37-15:40 UTC`:
  - 24 lock-timeout log lines
  - 19 `Post-commit group stats invalidation failed` warnings from settlement resolution
  - 5 `process_pending_group_stats_recalculation_task` errors
- Live DB state around `15:40 UTC`:
  - `group_stats_recalculation_task`: 261 open rows, all `started_at is not null`, none pending, none completed
  - 205 open rows were older than 30 minutes
  - 259/261 open rows had `resolved settlement ...` reasons
- Live lock sampling caught `echo-bgworker` queue inserts waiting on `transactionid` locks held by another `echo-bgworker` backend. The blocker was inside a multi-second transaction currently doing `orbit_unit` reads.
- `failed_inbox_unit_worker` currently has a huge backlog: 424,961 `failed_inbox_unit` rows where `deleted=true and is_bad_data=false`. It processes batches of 100 inside one transaction and enqueues group-stats recalculation inside that same transaction.
- Current settlement backlog is drained (`0` unresolved `sigint_inbox_item_settlement` rows), but settlement resolution did generate recent queue pressure. The remaining sustained pressure is mostly failed-unit verification.

## Root cause

`group_stats_recalculation_task` has a global partial unique index:

```sql
create unique index group_stats_recalculation_task_pending_unique_idx
    on group_stats_recalculation_task ((true))
    where completed_at is null and started_at is null;
```

This makes all producers contend on one pending queue tuple. Some producers call `enqueue_group_stats_recalculation_for_message` inside larger transactions. In particular, `failed_inbox_unit_worker` holds the queue tuple while it continues resolving the rest of its batch. Other bgworker tasks then wait on the same uncommitted unique-index tuple and hit the app's default 3s `lock_timeout`.

The stats worker has a second bug: after recalculating a one-day chunk, it enqueues the remainder before marking the current row completed. If that enqueue hits `lock_timeout`, the claimed row remains `completed_at = null` with `started_at` set. It is ignored until the 120-minute stale retry window, which explains the hundreds of open started rows.

## Fix plan

1. Hotfix `failed_inbox_unit_worker`.
   - In `run_failed_inbox_unit_worker_once`, collect affected inbox item IDs inside the transaction.
   - Commit the worker transaction.
   - Enqueue stats invalidations after commit on `DatabaseConnection`, not on `DatabaseTransaction`.
   - Prefer a batch enqueue helper instead of 100 per-message queue upserts.

2. Add a batch/coalescing stats invalidation API.
   - Add `enqueue_group_stats_recalculation_for_messages(dbx, item_ids, reason_prefix)`.
   - Query all affected messages in one SQL call.
   - Coalesce into the minimal global window because `recalculate_group_stats` rebuilds all groups for the time range.
   - Use it from settlement one-off/batch paths and failed-unit verification.

3. Make stats task finalization retry-safe.
   - Split task processing into: recalculate chunk, persist task outcome.
   - On successful chunk recalculation, persist completion/remainder with retry/backoff for SQLSTATE `55P03`.
   - Do not leave a successfully recalculated task stuck as open `started_at` just because the remainder enqueue was locked.
   - Add logging with task id and retry count for finalization retries.

4. Remove the global pending-row hot spot.
   - Add a migration that drops `group_stats_recalculation_task_pending_unique_idx`.
   - Change enqueue to plain insert, avoiding global unique-index contention.
   - Change the stats worker claim query to claim a bounded batch of pending/stale rows with `for update skip locked`, merge their windows, and process one coalesced task.
   - Mark all claimed rows completed after the chunk is persisted; insert one remainder row if the merged window still has work.

5. Clean up existing stuck state during deployment.
   - After deploying the code, reset or complete existing open `started_at` rows with a one-time migration or admin SQL reviewed before execution.
   - Prefer resetting them to pending if their recalculated chunk cannot be proven completed.
   - Verify `group_stats_recalculation_task` drains to a small number of open rows and lock-timeout logs stop.

6. Tests and checks.
   - Add a concurrency test for multiple enqueue callers while the worker is finalizing a chunk.
   - Add a regression test that a finalization `55P03` retry does not leave a claimed task stuck for 120 minutes.
   - Add a test for failed-unit verification ensuring stats invalidation happens after commit.
   - Run `cargo fmt`, `cargo check`, and relevant Rust tests.
