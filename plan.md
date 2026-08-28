# ORBIT automatic linking performance handoff

## Goal

Fix the severe slowdown in `tui-import-orbit-units` → `Link ORBIT units to SIGINT units` → `Automatic` without weakening per-batch revalidation when the synchronized ORBIT revision changes concurrently.

## Current diagnosis

- Equivalence classes are canonicalized; they are not expanded combinatorially.
  `normalize_unit_formation_name` tokenizes/lowercases a name and maps aliases from
  `UNIT_FORMATION_EQUIVALENT_NOTIONS` to canonical tokens.
- `TestLinkMatcher` builds exact `(echelon, normalized name)` and numeric
  `(echelon, leading number)` indexes. SIGINT units are therefore not compared
  against every ORBIT unit.
- Levenshtein distance is calculated only for structurally matched,
  maximum-rated candidates, using normalized SIGINT and ORBIT hierarchy names.
- The main regression is in automatic persistence batching:
  `persist_automatic_link_batches` processes reviewed SIGINT IDs in batches of
  100, while `persist_automatic_link_batch` reloads the full synchronized ORBIT
  snapshot and rebuilds `TestLinkMatcher` for every batch.
- Local debug data measured during diagnosis:
  - 50,160 synchronized ORBIT roots;
  - 1,603 SIGINT units in the automatic review set;
  - 17 persistence batches;
  - 307 active automatic links and 23 active manual links.
  This causes roughly 17 full database loads and matcher builds during
  persistence, in addition to the initial matcher build used to prepare links.
- Each automatic batch also runs global duplicate-candidate reconciliation.
  This may be a secondary cost, but repeated 50k-unit loading/normalization is
  the first issue to remove.

## Existing uncommitted work to preserve

The working tree was already dirty before this performance task:

- `wdintel-rs/src/orbit/test_link.rs`
  - changes automatic approval from requiring one candidate to choosing the
    unique closest rating-100 candidate within the distance limit;
  - adds/updates focused tests.
- `wdintel-rs/src/orbit/tui.rs`
  - updates the automatic-mode label to describe unique-closest behavior.

Do not overwrite or revert these edits. No performance implementation edits
have been made yet.

## Recommended implementation

1. Make `matching::TestLinkMatcher` own its `SourceUnit` candidates instead of
   borrowing the input slice.
   - Change `TestLinkCandidate<'a>` to store `SourceUnit`.
   - Remove the lifetime from `TestLinkMatcher`.
   - Keep `TestLinkMatcher::new(&[SourceUnit])` for existing tests/callers by
     cloning, and add an owning constructor such as
     `TestLinkMatcher::from_units(Vec<SourceUnit>)` for production paths.
   - Matcher methods can continue returning `&SourceUnit` borrowed from `self`,
     minimizing downstream changes.
2. In initial link preparation, consume the loaded ORBIT vector with the owning
   constructor. Drop the matcher after `prepare_review_units` so persistence
   does not retain a second 50k-unit snapshot.
3. Add an automatic-persistence matcher cache holding:
   - the latest `orbit_sync.id`;
   - an owned `TestLinkMatcher`.
4. Create the cache once in `persist_automatic_link_batches` and pass it
   mutably into each `persist_automatic_link_batch`.
5. After acquiring the existing ORBIT advisory transaction lock for a batch:
   - query `persistence::load_latest_sync`;
   - reuse the cached matcher when its sync ID is unchanged;
   - otherwise call `load_latest_synced_source_units`, rebuild the owning
     matcher once, and replace the cache.
   This preserves current behavior if an ORBIT sync occurs between committed
   batches while avoiding repeated loads/builds in the normal case.
6. Keep suppressions reloaded inside every batch; concurrent manual unlink
   suppressions must remain authoritative.
7. Keep duplicate reconciliation behavior unchanged in the first patch. If
   runtime remains high after matcher caching, profile it and then replace the
   global per-batch reconciliation with a correctly scoped equivalent rather
   than simply moving it out of batches (an interrupted run must not leave
   committed duplicate flags stale).
8. Optional follow-up only if profiling still identifies normalization as
   material: precompile the seven equivalence alias token lists in a
   `OnceLock`, because `equivalent_unit_notation_at` currently allocates an
   alias `Vec` for every alias at every input word.

## Correctness considerations

- Do not cache solely for the entire run without checking `orbit_sync.id`;
  imports use a transaction-scoped advisory lock and can complete between
  persistence batches.
- Do not cache suppressions across batches.
- Preserve revalidation under the advisory lock before writing each link.
- Avoid one transaction for all 1,603 units; batching was introduced to limit
  transaction size and preserve restart safety.
- Ensure the owning matcher does not clone all 50k units on production paths.

## Verification

Run, in order:

```bash
cargo fmt
cargo test -p wdintel-rs orbit::matching
cargo test -p wdintel-rs orbit::test_link
cargo check -p wdintel-rs
cargo clippy -p wdintel-rs --all-targets -- -D warnings
```

Then rerun the debug automatic linking workflow and compare elapsed time. The
normal unchanged-revision path should build the persistence matcher once, not
once per 100-unit batch.

Before handing changes back, run:

```bash
git status --short
git diff --check
git diff -- wdintel-rs/src/orbit/matching.rs wdintel-rs/src/orbit/test_link.rs wdintel-rs/src/orbit/tui.rs plan.md
```

Do not commit or push without explicit user permission.
