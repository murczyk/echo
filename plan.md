# Interactive `oneoff-test-link-units` plan

## Intended behavior

Convert `oneoff-test-link-units` from a batch stdout report into one continuous TUI review session:

1. Read legacy SIGINT units from `/var/tmp/units.csv`; retain the existing missing-file error and path hint.
2. Load the latest ORBIT revision and build the existing echelon matcher once.
3. Open the terminal UI once, then review units with multiple matches before units with a single match, ordered by ascending Levenshtein distance within each group.
4. For each SIGINT unit, display:
   - progress (`current / total`);
   - SIGINT unit ID and name;
   - all non-empty echelons, ordered from smaller to larger, in parentheses;
   - up to five maximum-rated ORBIT matches at once, including each option number, rating, and full generative name;
   - the full SIGINT and ORBIT names with word-level matching/mismatching highlights, their Levenshtein distance, ORBIT UUID, and operational hierarchy for every match.
5. Wait for the user to decide before advancing:
   - `Enter`, `y`, or `1`: accept the first visible option;
   - `2` through `5`: accept the corresponding visible option;
   - `f`/`b`: show the next/previous five options;
   - `0` or `n`: deny it;
   - `Up`/`Down` and `PageUp`/`PageDown`: scroll when the match list does not fit;
   - `q`, `Esc`, or `Ctrl-C`: stop the review early after confirmation.
6. After the final unit, restore the terminal and print a compact summary containing accepted, denied, and unreviewed counts.

Accept and deny are review decisions only. The command remains read-only and does not create or update SIGINT–ORBIT links. Persisting accepted links would need separate requirements because the CSV contains legacy records and a single SIGINT unit can have multiple equally rated ORBIT candidates.

## Implementation changes

### `wdintel-rs/src/orbit/test_link.rs`

- Keep CSV parsing and match preparation separate from terminal interaction.
- Replace batch `print_matches` output with a review loop that creates a presentation record for one SIGINT unit at a time.
- Add small state types for the current unit, scroll position, decision counts, and completion/early-exit outcome.
- Keep all equally rated maximum matches available; accepting chooses one visible candidate for the current read-only review decision.
- Skip units with no matches automatically.

### `wdintel-rs/src/orbit/tui.rs`

- Reuse `OrbitTerminal` so raw-mode setup and cleanup remain centralized and reliable.
- Add a dedicated test-link review screen renderer and key-event loop rather than mixing this workflow into the existing ORBIT synchronization menu.
- Keep screen layout and input-to-action mapping in small functions to make terminal behavior testable without a live terminal.

### Matching code

- Preserve the current matching rules in `wdintel-rs/src/orbit/matching.rs`:
  - exact corresponding echelon matches keep the rating at 100;
  - matching numeric prefixes with different text deduct one point per weak match;
  - candidates below the maximum rating for that SIGINT unit are discarded;
  - all candidates tied at the maximum rating are displayed.
- Do not recompute or alter match ratings inside the TUI.

### Documentation

- Update `docs/ORBIT.md` to describe the interactive review, controls, read-only acceptance semantics, input location, and early-exit summary.

## Verification

- Add focused tests for:
  - accept and deny advancing exactly one unit;
  - progress and summary counts;
  - multiple maximum-rated candidates remaining together;
  - no-match units being skipped;
  - scrolling being clamped and reset for the next unit;
  - match options being paged five at a time and only visible options being selectable;
  - early exit leaving remaining units unreviewed;
  - key-to-action mapping.
- Retain the existing CSV and echelon-matching tests.
- Run:
  - `cargo fmt`
  - targeted `oneoff-test-link-units` unit tests
  - `cargo check -p wdintel-rs`
  - `cargo clippy -p wdintel-rs --all-targets -- -D warnings`

## Out of scope

- Writing accepted matches to the database.
- Resuming a partially completed review across command invocations.
- Front-end or `/admin/units` changes.
