# Duplicate-unit merge: staged reassignment and live progress

## Finding

`/rer-units-neo` calls `/api/sigint/unit/delete-duplicate`. The endpoint currently
opens one transaction around `merge_units_in_transaction`, including callsign,
signal, network-unit, attachment, label, inbox-item, ORBIT-link, and device
reassignment. Callsigns, signals, network units, and inbox links are handled
row by row; the former three also write changelog entries. This can hold locks
for a long time. `sigint_network_callsign.unit_id` also references units but is
not moved by the current merge. Unit changelog/history references remain on the
deleted duplicate by design; they are not live dependencies to reassign.

## Requested behavior

- Scope: the web duplicate-merge endpoint used by `/rer-units-neo` and the
  admin duplicate list. Create-unit, TUI, and ORBIT batch merges retain their
  existing atomic transaction behavior.
- Reassign each dependency category in bounded, committed row batches,
  retaining the current audit and link-conflict behavior; retries resume
  safely after a partially moved category.
- After all categories, check for newly attached dependencies. If any exist,
  repeat the reassignment loop. Only finalize the survivor and mark the
  duplicate deleted in a short transaction after a clean check under unit row
  locks.
- Run the web merge as a `bgtask`. Expose live progress based on the number of
  dependency categories, with equal weight for each category. Keep reported
  progress monotonic across retries; reserve completion for the final commit.
- Show the task's progress and error in the merge dialog on `/rer-units-neo`.
  Adapt the other React caller of the same endpoint as needed.

## Implementation plan

1. Extract the existing dependency moves into category functions so the
   synchronous internal merge path can keep its current behavior while the web
   task can run one category transaction at a time. Add the omitted network
   callsign unit reference, including its changelog behavior. Add indexes for
   the large reference tables queried by unit ID.
2. Add a staged merge coordinator: validate and serialize the pair, run the
   bounded category batches, recheck all dependencies, and retry on new work.
   Finalize metadata, changelog, parent/ORBIT reconciliation, and deletion only
   after a clean check in the final transaction. Preserve retry safety if a
   prior category committed before an error. Hold the existing advisory merge
   locks in a coordination-only transaction across phases; make synchronous
   internal merge callers acquire the same locks in sorted order.
3. Change the web endpoint to start a background task and return its ID. Write
   stage logs and a monotonic percentage to `bgtask`; finish with success or
   failure and send the unit-changed event after completion or failure.
4. Poll the existing bgtask status API from the merge dialog. Display equal
   category progress without allowing the bar to move backwards; refresh the
   unit list after success or failure because earlier batches may have
   committed. Retain the task ID across
   navigation and mark interrupted tasks on API restart. Update both React
   callers and the unused Elm API response decoder for the endpoint's new
   return type.
5. Add focused database-backed coverage for staged movement, retries after
   newly attached references, and finalization. Run
   `cargo fmt`, `cargo check`, `cargo clippy`, focused tests, frontend staged
   formatting, and `just build-front`.

## Concurrency and recovery

The final transaction locks both unit rows and checks dependencies again before
marking the duplicate deleted. A writer that attaches to the duplicate after
that commit is outside this task's control unless all unit-reference writers
are changed to reject deleted units; this pre-existing soft-delete race is not
introduced by the staged task. A failed or interrupted task leaves already
committed reassignments intact. A retry must use the original survivor, which
is pinned by the first task record. Each ORBIT-link batch reconciles derived
duplicate and inconsistency state before commit, and failed or recovered tasks
publish unit-change events for other clients.

The local development database has no rows in the large reference tables,
so it cannot provide a production-scale query plan or a meaningful timing
comparison. The index columns match the unit-ID predicates used by the staged
steps and final check.

## Verification

- Three database-backed staged merge tests passed, including bounded label
  batches, a late inbox reference, restart recovery, survivor reconciliation,
  and the direct network-callsign audit entry.
- Focused React tests and `just build-front` passed.
- The catalog-aware analytics migration check passed on a database restored
  from the standard test dump; `just migrate-up`, `cargo check`, and Clippy
  passed.
- Entity generation was attempted after applying the index-only migration.
  The local database lacks checked-in relation helpers, so unrelated generated
  differences were reverted; no entity change is needed for the new indexes.
