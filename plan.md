# Plan

## Context

- Workspace: `/home/andrii/.workspace/echo`.
- User asked to add a new `tui-import-orbit-units` TUI option for manually reviewing all `sigint_unit` duplicate candidates pair by pair, optionally confirming merges.
- Existing ORBIT duplicate merge behavior should stay unchanged:
  - automatic duplicate merge persists one selection per transaction;
  - manual ORBIT duplicate merge persists selections in batches of 20;
  - no switch to one huge transaction.
- `sigint_unit.is_deduplicate_candidate` is maintained by `orbit::reconcile_sigint_unit_deduplicate_candidates`: non-deleted SIGINT units sharing an active, unsuppressed, non-deleted ORBIT link become `Some(true)`; non-candidates become `Some(false)`.
- Existing merge primitive is `sigint::unit::merge_units_in_transaction`; it locks both units, moves linked data and ORBIT links to the survivor, soft-deletes the duplicate, re-evaluates duplicate-candidate state, and reconciles ORBIT hierarchy on the survivor.

## Done

- Added new TUI start action `ReviewSigintDuplicateCandidates` in `wdintel-rs/src/orbit/tui.rs`.
- Added new main menu entry: `Review all SIGINT duplicate candidates pair by pair`.
- Added new TUI pair-review DTOs and decision enum:
  - `SigintDuplicateReviewUnit`
  - `SigintDuplicateReviewPair`
  - `SigintDuplicatePairReviewDecision`
- Added new pair-review screen in `wdintel-rs/src/orbit/tui.rs`:
  - shows left/right SIGINT unit IDs, active state, names, and shared ORBIT UUIDs;
  - renders word diffs for name, hierarchy, active, comment, orbit note, `sigint_origin_id`, and `original_id`;
  - keys: `1` merge left into right, `2` merge right into left, `0`/`n` skip, `q`/Esc/Ctrl-C quit.
- Added TUI unit tests for pair diff rendering and key mapping.
- Added `wdintel-rs/src/orbit/duplicate_candidate_review.rs`.
- New module behavior:
  - acquires ORBIT advisory lock while building the initial review plan;
  - re-runs `reconcile_sigint_unit_deduplicate_candidates`;
  - loads all non-deleted `sigint_unit` rows with `is_deduplicate_candidate = true`;
  - loads their active ORBIT links;
  - builds unordered pairs for every shared ORBIT unit and deduplicates pair direction;
  - tracks confirmed review merges with `ReviewPairTracker`;
  - after `B -> A`, later source pairs involving `B` are shown through `A`, so `C` is compared with `A`, not `B`;
  - avoids showing both `A/B` and `B/A`.
- Persistence behavior in new module:
  - confirmed merges are persisted after review;
  - selections are processed in chunks of `ORBIT_DUPLICATE_UNITS_PERSIST_BATCH_SIZE` (`20`);
  - each chunk acquires the ORBIT advisory lock and opens a transaction;
  - before writing, it re-runs duplicate-candidate reconciliation;
  - skips stale selections unless both units are still live duplicate candidates and still share an active ORBIT link;
  - calls `merge_units_in_transaction` for each confirmed merge.
- Wired new module into `wdintel-rs/src/orbit/mod.rs`:
  - `mod duplicate_candidate_review;`
  - dispatcher branch for `StartAction::ReviewSigintDuplicateCandidates`.
- Updated `deploy/2026-07-29-orbit-dictionaries/README.md` with the new menu option and workflow behavior.
- Ran `cargo fmt --all` successfully after edits.
- Current changed files:
  - `deploy/2026-07-29-orbit-dictionaries/README.md`
  - `wdintel-rs/src/orbit/mod.rs`
  - `wdintel-rs/src/orbit/tui.rs`
  - `wdintel-rs/src/orbit/duplicate_candidate_review.rs` (new/untracked)

## Verification Status

- First attempted command was invalid:
  - `cargo test -p wdintel-rs orbit::duplicate_candidate_review orbit::tui -- --nocapture`
  - Cargo accepts only one test-name filter, so it failed with `unexpected argument 'orbit::tui'`.
- Then two focused test commands were started concurrently:
  - `cargo test -p wdintel-rs orbit::duplicate_candidate_review -- --nocapture`
  - `cargo test -p wdintel-rs orbit::tui -- --nocapture`
- Concurrent test run found:
  - missing `QuerySelect` import for SeaORM `.join(...)`;
  - unused `TransactionTrait` import.
- Fixed the import in `wdintel-rs/src/orbit/duplicate_candidate_review.rs`.
- Ran `cargo fmt --all` successfully again.
- Restarted:
  - `cargo test -p wdintel-rs orbit::duplicate_candidate_review -- --nocapture`
- The user interrupted while that test command was still compiling, so no passing test result is recorded after the import fix.

## Remaining Work

1. Check whether any old Cargo process is still running; stop only if it is clearly from the interrupted verification command.
2. Run focused tests serially:
   - `cargo test -p wdintel-rs orbit::duplicate_candidate_review -- --nocapture`
   - `cargo test -p wdintel-rs orbit::tui -- --nocapture`
3. Fix any compile/test failures.
4. Run required Rust validation:
   - `cargo check -p wdintel-rs`
   - `cargo clippy -p wdintel-rs --all-targets --all-features -- -D warnings`
   - optionally full `cargo test -p wdintel-rs` or `just test-be` if time permits.
5. Review final diff for scope and style.
6. If `.env` contains `MATTERMOST_NOTIFICATION_HOOK`, notify once the work is finished.

## Important Review Points

- Confirm `ReviewPairTracker` behavior still satisfies:
  - no `A -> B` and `B -> A` duplicate prompts;
  - after confirming `B -> A`, future `B/C` source pairs display as `A/C`;
  - if later confirming `A -> C`, the persisted order remains `B -> A`, then `A -> C`.
- Consider whether the displayed shared ORBIT UUIDs for rewritten pairs should be recomputed from planned survivor state instead of using the source pair's shared ORBIT UUIDs. Current logic displays the source shared link, which should become shared after earlier planned merges move links to the survivor.
- Confirm persistence should require both selected units to still have `is_deduplicate_candidate = true`. This is intentionally conservative; stale or no-longer-candidate pairs are skipped.
