# WIP

## Task

Add metadata span support for SIGINT inbox items on `/rer-analysis` and `/rer-duty`:

- preserve zero-based inclusive text indices for parsed metadata values
- store those indices in DB
- propagate them through backend/frontend types
- highlight those text ranges in rendered inbox messages
- make highlighted metadata clickable
- clicking should open `/rer-analysis` for the message day, from `00:00` to next day `00:00`, with the matching metadata filter applied

Example target behavior:

- text: `hello cc 545`
- `cc_start_index = 9`
- `cc_end_index = 11`
- clicking `545` opens `/rer-analysis` filtered by `metadata: cc=545`

## Changes made so far

### Modified

- [wdintel-rs/src/rer_importer/inbox/metadata.rs](/home/andrii/.workspace/echo-copy/wdintel-rs/src/rer_importer/inbox/metadata.rs)

### What changed in that file

- Extended `InboxMetadata` with new start/end index fields for:
  - `cc`
  - `cg`
  - `cg_name`
  - `id`
  - `id_name`
  - `hash_id`
- Started refactoring parser internals to preserve source spans:
  - added `MatchedValue`
  - added `SourceSpan`
  - added `NormalizedLine`
- Reworked `WorkingMetadata` to carry values together with source indices
- Started changing `parse_metadata` to:
  - keep original line text
  - normalize emoji keycap digits without losing source positions
  - apply line offsets so spans become message-global indices
- Updated metadata insert preparation in `refresh_metadata_for_body` to write the new span fields into `sigint_inbox_item_metadata`
- Started changing multi-source-id expansion so split IDs can keep individual spans

## Current status

This is a partial backend refactor only.

It is not validated yet.

I did **not** yet:

- add the DB migration
- update SeaORM entity fields
- update inbox metadata lateral query JSON
- update Rust API types exposed to Elm/TS
- regenerate bindings
- implement frontend highlighting/click navigation
- run `cargo fmt`
- run `cargo check`
- run `cargo clippy`
- run `just build-front`

## Known risk right now

The current `metadata.rs` edit is likely not compiling yet. It was stopped mid-flight before verification.

Most likely follow-up fixes will be needed around:

- regex helper calls now using `NormalizedLine`
- `parse_metadata` line iteration and last-line offset handling
- use of `.pipe(...)` if trait/import is not available in this module
- tests in `metadata.rs`, because `InboxMetadata` gained new fields

## Full remaining plan

### 1. Finish backend parser refactor

- make `metadata.rs` compile cleanly
- ensure spans are zero-based and inclusive
- confirm spans are global over the full message text, not per-line
- keep emoji-digit parsing working
- keep multi-source-id expansion working with individual spans
- add/adjust tests for indices

### 2. Add DB schema support

- create a new pure-SQL migration in `echo-migration/src/`
- add nullable integer columns to `sigint_inbox_item_metadata` for all stored metadata span pairs:
  - `color_code_start_index`, `color_code_end_index`
  - `call_group_id_start_index`, `call_group_id_end_index`
  - `call_group_name_start_index`, `call_group_name_end_index`
  - `sender_id_start_index`, `sender_id_end_index`
  - `sender_name_start_index`, `sender_name_end_index`
  - `hash_id_start_index`, `hash_id_end_index`
- register the migration in `echo-migration/src/lib.rs`
- run `just migrate-up`
- run `just gen-seaorm`

### 3. Propagate spans through backend response types

- update:
  - [wdintel-rs/src/entities/sigint_inbox_item_metadata.rs](/home/andrii/.workspace/echo-copy/wdintel-rs/src/entities/sigint_inbox_item_metadata.rs)
  - [wdintel-rs/src/rer_importer/types.rs](/home/andrii/.workspace/echo-copy/wdintel-rs/src/rer_importer/types.rs)
  - [wdintel-rs/src/rer_importer/inbox/query.rs](/home/andrii/.workspace/echo-copy/wdintel-rs/src/rer_importer/inbox/query.rs)
- extend the metadata lateral JSON aggregation so inbox API returns the new span fields
- keep existing metadata filtering logic unchanged

### 4. Regenerate frontend bindings

- run `just gen-front`
- verify generated updates in:
  - [wdintel-web/src/Bindings.elm](/home/andrii/.workspace/echo-copy/wdintel-web/src/Bindings.elm)
  - [wdintel-web/src/Bindings.ts](/home/andrii/.workspace/echo-copy/wdintel-web/src/Bindings.ts)

### 5. Add frontend metadata link rendering

- update shared rendering for `/rer-analysis`:
  - [wdintel-web/src/Shared/Components/RerMessage.elm](/home/andrii/.workspace/echo-copy/wdintel-web/src/Shared/Components/RerMessage.elm)
- update `/rer-duty` rendering:
  - [wdintel-web/src/Pages_/RerDuty/Waterfall/Message.elm](/home/andrii/.workspace/echo-copy/wdintel-web/src/Pages_/RerDuty/Waterfall/Message.elm)
- likely update marked-text rendering so metadata links can coexist with current text token rendering:
  - [wdintel-web/src/Shared/MarkedText.elm](/home/andrii/.workspace/echo-copy/wdintel-web/src/Shared/MarkedText.elm)

Implementation approach planned:

- build metadata link descriptors from `message.metadata`
- for each descriptor, map to the right filter bucket:
  - `colorCode` -> `metadataCc`
  - `senderId` / `senderName` -> `metadataSender`
  - `callGroupId` / `callGroupName` -> `metadataReceiver`
  - `hashId` -> `metadataHash`
- derive the message day from `message.timestamp` or `message.date`
- generate a fresh `RerAnalysisQueryState`:
  - `dateFromStr = message day`
  - `timeFromStr = "00:00"`
  - `dateToStr = next day`
  - `timeToStr = "00:00"`
  - only the clicked metadata filter filled
- render the matched substring as highlighted anchor text to `/rer-analysis?state=...`

### 6. Validation

- run `cargo fmt`
- run `cargo check`
- run `cargo clippy -p wdintel-rs -- -D warnings` if repo setup expects that target, otherwise repo-standard clippy command
- run `just build-front`
- inspect `git diff`

## Resume point

Resume from:

- [wdintel-rs/src/rer_importer/inbox/metadata.rs](/home/andrii/.workspace/echo-copy/wdintel-rs/src/rer_importer/inbox/metadata.rs)

First action on resume:

- make the current parser refactor compile before touching migrations or frontend
