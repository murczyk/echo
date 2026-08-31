# Unit Autolink And Duplicate Auto-Resolve Plan

## Current Evidence

Reviewed `echo-zp2` on 2026-08-31 after the reported run:

- Unparsed-unit TUI output reported: accepted 43, denied 0, unreviewed 0, resolved 43 labels.
- Remaining non-archived unresolved labels: 563 normalized labels, about 53k failed rows.
- Archived unresolved labels: 2,412 normalized labels, about 62k rows.
- Top remaining buckets by rough pattern:
  - battalion chains: 88 labels / 20.3k rows;
  - brigade-like chains: 24 labels / 8.9k rows;
  - radio-network/descriptive noise: 355 labels / 8.0k rows;
  - company/battery chains: 44 labels / 7.3k rows;
  - regiment chains: 25 labels / 6.0k rows;
  - army/corps-only chains: 4 labels / 2.2k rows.
- Rough local prefix diagnostic found 77 labels / 21.6k rows that look like current ORBIT hierarchy prefixes:
  - 38 labels / 16.2k rows point to ORBIT roots with no active SIGINT link;
  - 33 labels / 3.1k rows point to uniquely linked ORBIT roots but are still missed by parser/matcher rules;
  - 6 labels / 2.3k rows point to ORBIT roots blocked by duplicate SIGINT links.
- Remaining ORBIT duplicate state: 47 ORBIT units have multiple active SIGINT links, covering 95 group memberships / 94 distinct SIGINT units. 45 groups have members with only that one shared ORBIT link; 2 groups include a member with another active ORBIT link. Only one remaining pair has an exact identical `sigint_unit.name`.

## Main Findings

The current unparsed-label workflow is too strict for the current data shape:

- `parse_library_unit_typed_segments` can only emit company, battalion, regiment, division, and army. The DB and ORBIT matcher already support brigade and corps, but unparsed labels such as `60 омсбр 5 а`, `38 омсбр 35 а`, and `1 мсб 68 ак` are forced through the old five-level parser and fail root/parent echelon matching.
- Brigade words are present in the legacy regiment list, and corps-like words such as `ак` are present in the army list. That creates false echelons before the ORBIT matcher gets a chance to score the label.
- `за` is common in unresolved labels but is not an equivalent of `а`/`зва`/`оа` in `UNIT_FORMATION_EQUIVALENT_NOTIONS`.
- ORBIT names contain non-identity qualifiers such as `(на БМП)`, `(кт)`, `(ш)`, `ТрВ`, `УВ(с)`, `ОУВ(с)`, and theater abbreviations. The automatic gate requires rating 100, unique closest candidate, and Levenshtein distance <= 10, so same-number labels can be left for manual review instead of auto-resolved.
- The workflow cannot resolve a good ORBIT match if the ORBIT root has no active SIGINT link. This is currently the largest measured blocker among prefix-like labels.
- Radio-network text is polluting the unresolved-unit queue. The current auto-archive list only handles `нв`, `н/в`, and `н.в.`.

The duplicate workflow is conservative in the right direction, but it lacks useful safe tiers:

- `tui-merge-orbit-unit-duplicates` only loads groups where every member has the one shared ORBIT link and every member is still an automatic match to that ORBIT unit.
- `Reconcile linked SIGINT units and merge exact duplicates` only merges exact duplicate names within an ORBIT group.
- Remaining groups are mostly short legacy SIGINT units versus fuller ORBIT-imported units. Many have one active and one inactive member, differing only by ORBIT qualifiers or hierarchy depth. Exact-name-only merging barely touches those.

## Implementation Plan

1. Add a read-only dry-run report for both workflows.
   - Report counts by blocker reason: parser rejected, no ORBIT match, ambiguous ORBIT match, match distance/rating rejected, ORBIT has no SIGINT link, ORBIT has multiple SIGINT links, duplicate group has multi-link member, duplicate group no longer matches.
   - Print top labels/groups per blocker with quantities and candidate ORBIT/SIGINT IDs.
   - Reuse the production parser/matcher instead of SQL approximations.

2. Extend the unparsed-label parser to current hierarchy levels.
   - Add brigade and corps to the typed parser path and map them to `EchoEchelon::Brigade` and `EchoEchelon::Corps`.
   - Split legacy word lists so brigade abbreviations stop pretending to be regiments and corps abbreviations stop pretending to be armies.
   - Keep existing strict increasing-echelon validation, then add tests for brigade/corps chains from the observed data.

3. Improve unit-name normalization without globally weakening approval.
   - Add `за` as an army equivalent if review confirms it is a frequent `зва` shorthand/typo.
   - Add identity-preserving qualifier variants for ORBIT/SIGINT matching: equipment/platform notes, `(ш)`, `(кт)`, `ТрВ`, and theater/control wrappers where they are not the unit identity.
   - Keep automatic approval at rating 100 + unique closest candidate; make better normalization produce rating 100 only for safe equivalent names.

4. Add automatic cleanup for non-unit failed labels.
   - Expand failed-unit auto-archive with guarded radio-network patterns: `УКХ`, `р/м`, `радіомережа`, `МГц`, `DMR`, `управління`, `оповіщення`, `пости/ППС`, `УНПП`, and location-only markers.
   - Apply only when the structured unit parser does not return a valid hierarchy, so valid labels containing a unit number are not hidden accidentally.
   - Add a dry-run count and tests from active unresolved examples before enabling mutation.

5. Resolve uniquely matched but unlinked ORBIT roots.
   - Add a manual-first TUI action that reviews unresolved labels whose normalized hierarchy uniquely matches an unlinked ORBIT root.
   - On accept, create/import the SIGINT unit from ORBIT, link it, add the failed label as an alias, and mark failed rows pending for reprocessing.
   - Consider automatic mode only for exact normalized hierarchy prefixes with one ORBIT candidate, no duplicate ORBIT root, and no existing conflicting SIGINT unit.

6. Improve duplicate auto-resolve in tiers.
   - Tier 1: keep exact-name merges as today.
   - Tier 2: merge same shared ORBIT link when normalized hierarchy fields are equivalent after the new qualifier/army normalization and no populated field conflicts.
   - Tier 3: merge one-active/one-inactive groups when the inactive unit was ORBIT-created/imported, the active unit is the only active survivor, all labels/links can move, and ORBIT reconciliation will fill missing hierarchy.
   - Leave multi-link members and conflicting first-identity groups for manual review.

7. Make survivor choice explicit and audited.
   - Prefer active survivor, then richer non-empty user-maintained fields, then lower ID.
   - Preserve current merge behavior that moves labels, inbox links, ORBIT links, notes, and recalculates hierarchy/deduplicate flags.
   - Log every auto-merge with ORBIT ID, deleted unit ID, survivor ID, tier, and normalized reason.

8. Verification.
   - Add focused backend tests for parser echelons, normalization variants, unparsed dry-run blocker reasons, unlinked ORBIT-root review, and duplicate tier decisions.
   - Run `cargo fmt`, `cargo check`, and targeted backend tests; run `cargo clippy` if the change touches shared matcher/parser code.
   - On `echo-zp2`, run dry-run before and after deployment, then run automatic workflows and compare resolved labels, archived noise, and remaining duplicate blocker counts.

## Implementation Handoff (2026-08-31)

Implementation was intentionally stopped at the user's request. The working tree contains uncommitted, partial changes and must not be treated as ready for a mutating production run.

### Partially Implemented

- Added `--dry-run` CLI parameters to `tui-resolve-orbit-unparsed-units` and `tui-merge-orbit-unit-duplicates` and routed them through the ORBIT entrypoints.
- Extended `UnitType` with brigade and corps and added separate brigade/corps notion sets so typed parsing can distinguish them from regiments and armies.
- Added `за` to army-equivalent normalization.
- Added explicit ORBIT matching normalization for selected non-identity qualifiers: platform parentheses, `(кт)`, `(ш)`, `ТрВ`, `УВ(с)`/`ОУВ(с)`, and named control wrappers.
- Added guarded failed-label archive words and prevented auto-archive when the typed hierarchy parser recognizes a valid unit chain.
- Added most of an unparsed-label dry-run classifier and report, including parser, match-quality, ambiguity, missing-link, duplicate-link, and auto-resolvable buckets with candidate IDs.
- Added partial automatic archival of existing guarded non-unit labels.
- Added a transaction helper and partial persistence path for manually importing an unlinked ORBIT root before resolving its failed label.
- Ran `cargo fmt --all`. A subsequent `cargo check -p wdintel-rs` was interrupted before completion and its result is unknown.

### Known Incomplete / Likely Compile Breaks

- `duplicate_units::run` still accepts only `mode`; callers now pass `(mode, dry_run)`. Implement the duplicate dry-run path and update this signature first.
- Existing `unparsed_units` tests still construct `BTreeMap<Uuid, i64>` link maps; production helpers now expect `BTreeMap<Uuid, BTreeSet<i64>>`.
- The new brigade/corps arrays, parsing order, normalization regexes, archive helper, and manual import path have not completed compilation or test validation.
- Review whether broad archive markers such as `район`, `управління`, and `ппс` are sufficiently conservative on real data; the parser guard is present, but the `echo-kharkiv2` dry run is still required before enabling mutation.
- Review the unlinked-root batch behavior for multiple labels selecting the same ORBIT root and add a focused transaction test.
- The unparsed dry-run classifier needs tests for every blocker and a check that ambiguity is decided before filtering by SIGINT links.

### Remaining Implementation

1. Finish the duplicate dry-run report using production matcher results. Report safe groups, multi-link members, no-longer-matching members, ineligible hierarchy conflicts, ORBIT IDs, SIGINT IDs, and names.
2. Implement duplicate merge tiers:
   - exact-name tier;
   - normalized-equivalent hierarchy tier with no populated-field conflicts;
   - one-active/system-created-inactive tier only when missing fields are non-conflicting.
3. Make automatic survivor selection prefer active, then richer populated user-maintained fields, then lower ID. Include ORBIT ID, survivor/deleted IDs, tier, and normalized reason in every automatic merge log.
4. Keep manual duplicate review available for safe groups rejected by automatic tiers; continue excluding any member with another active ORBIT link.
5. Complete parser tests for `60 омсбр 5 а`, `38 омсбр 35 а`, and `1 мсб 68 ак`, plus the strict decreasing/repeated-echelon rejection.
6. Add matching tests proving qualifiers normalize to rating 100 without weakening the unique-closest, rating-100, distance-10 gate.
7. Add failed-label cleanup tests and dry-run blocker tests using realistic unresolved examples.
8. Compile and fix all errors, then run:
   - `cargo fmt --all -- --check`
   - targeted parser/ORBIT/inbox tests
   - `cargo check -p wdintel-rs`
   - `cargo clippy -p wdintel-rs --all-targets -- -D warnings`
9. Review `git diff` against `CODE_REVIEW.md`, especially every newly propagated Rust error and the read-only guarantees of both dry-run commands.
10. Build a temporary binary and run only the two `--dry-run` commands against `echo-kharkiv2`. Inspect every proposed automatic match for vague same-number or shortened-hierarchy matches. Do not run automatic/manual mutation there until the report is reviewed.
11. After `echo-kharkiv2` is clean, perform the planned before/after dry-run comparison on `echo-zp2` around deployment.

### Resume Commands

```bash
git status --short
git diff --stat
cargo check -p wdintel-rs
```
