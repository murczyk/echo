# echo-skhid settlement lock amplification plan

## Conclusion

The statement is true for echo-skhid, with one important correction: this is
not just "a lot of data overwhelms the worker". The historical settlement
backlog was the trigger, but the extra root cause is lock amplification.

The settlement worker holds advisory lock `2287` while processing a batch. Each
item can upsert the single pending `group_stats_recalculation_task` row. When
that upsert waits on the row/index lock and hits the live 3-second
`lock_timeout`, other messenger transactions waiting for advisory lock `2287`
also time out, retry, and add more work.

Relying on a previous successful settlement resolution for the same settlement
text plus AOR scope can reduce duplicate resolver work, but it is a secondary
optimization. It does not remove the failure mode unless the advisory-lock and
stats-invalidation transaction boundaries are fixed.

## Verification

- echo-skhid runs `wdintel-rs 0.1.1-rc.202608311445`, which contains
  `86493066e`.
- Live echo-skhid config has `postgres_runtime.lock_timeout_ms = 3000`.
- `BATTLE_LINE_UPLOAD_ADVISORY_LOCK_KEY` is `2_287`.
- `run_inbox_settlement_worker_once()` takes `lock_updates()` in an outer
  transaction, then calls `process_pending_rows()`, then commits the outer
  transaction.
- `process_pending_rows()` processes up to
  `INBOX_SETTLEMENT_WORKER_BATCH_SIZE = 25` item transactions while that outer
  advisory lock is still held.
- The one-off historical path currently holds the same lock across
  `INBOX_SETTLEMENT_ONEOFF_TRANSACTION_BATCH_SIZE = 50` items.
- `86493066e` introduced stats recalculation enqueueing from settlement link
  changes in `settlement_queue.rs`.
- `group_stats_recalculation_task_pending_unique_idx` allows only one pending
  row, and `enqueue_pending_group_stats_task()` upserts that row.
- SigNoz for `ct-echo-skhid`, 2026-09-01 09:46 through the full 10:22 UTC
  minute, shows 1,458 PostgreSQL lock timeout logs and 940 exact message queue
  retry logs.
- SigNoz stats-worker errors include PostgreSQL `55P03` while inserting an
  index tuple in `group_stats_recalculation_task`.
- Smaller lock-timeout and retry recurrences appeared after the restart, so the
  restart broke the retry loop but did not fix the underlying interaction.

## Fix Plan

1. Shorten advisory lock `2287` scope.
   - In `run_inbox_settlement_worker_once()`, keep `lock_updates()` only around
     the battle-line/AOR catalog snapshot refresh that actually needs it.
   - Commit that transaction before item processing starts.
   - Let item processing rely on the existing per-item advisory lock and row
     `FOR UPDATE` lock.
   - Apply the same principle to `process_oneoff_batch()` so the one-off path
     does not hold `2287` across 50 item updates.

2. Move stats invalidation outside item transactions.
   - Change `persist_settlement_resolution()` to update the settlement row and
     return the affected `item_id` or an invalidation flag, without enqueueing
     stats inside the transaction.
   - Change `process_oneoff_item_in_transaction()` similarly.
   - Update `reconcile_item_locations()` so callers can enqueue after their own
     transaction commits instead of doing it inside the location reconciliation
     transaction.
   - After each item transaction commits, enqueue group stats recalculation via
     a short separate transaction/connection.
   - Deduplicate affected item IDs per batch before enqueueing when practical.
   - Log enqueue failures separately; they should not roll back successful
     settlement linking.

3. Add previous-resolution reuse as a load reduction, not as the primary fix.
   - Use an in-memory cache first, scoped to one worker iteration or one-off
     batch, with key:
     `active_battle_line_version_id + sorted_aor_ids + normalized_settlement_text`.
   - Cache only deterministic resolution results produced under the current
     battle-line/AOR snapshot.
   - Treat persistent reuse of old rows as a later optimization unless it also
     stores enough versioning to prove the old result was resolved under the
     current battle line and current AOR settlement config.
   - Do not blindly reuse rows by settlement text alone; repeated settlement
     names can exist inside the same broader data set, and active battle-line or
     AOR geometry changes can alter the chosen match.

4. Add regression tests.
   - Verify the inbox settlement worker does not hold advisory lock `2287` while
     stats enqueueing is blocked.
   - Verify settlement row updates commit even if post-commit stats enqueueing
     fails.
   - Update the existing stats-invalidation test so it expects enqueueing after
     transaction commit.
   - Add a focused test for duplicate settlement text within the same AOR scope
     using the in-memory cache.

5. Validate and deploy.
   - Run `cargo fmt`.
   - Run `cargo check`.
   - Run focused settlement/stat tests.
   - Run `cargo clippy` before handoff.
   - No schema migration is expected for the primary fix.
   - After deploy, monitor SigNoz for PostgreSQL lock timeouts, message queue
     retry logs, and `inbox_settlement_worker` iteration duration.

## Immediate Mitigation

If echo-skhid needs relief before the code fix is deployed, temporarily reduce
or pause settlement backlog draining and restart the background worker only to
break active retry loops. This is mitigation only; it does not fix the
lock-amplification bug.
