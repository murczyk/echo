# Fix Implementation Plan

## Scope

Implement GOI palette sync/conversion/checksum fixes, GOI frequency readonly regression coverage, and the `/rer-palitra-neo` UI support needed for changelog, retry, and GOI-owned palette edit blocking.

## Conflict Review

- `suggestions.md` and this plan do not have known conflicts.
- `oplan.md` was requested but does not exist in this checkout; this plan uses the existing `plan.md`.
- Decisions from the removed `suggestions.md` are incorporated below.

## Decisions

- GOI-origin convertible palettes are GOI-owned. Echo-side edits must be blocked; the UI should show a banner telling users to edit the palette in GOI.
- Add schema migrations as needed.
- Replace `goi_palitra_sync.last_error` with a JSONB `changelog` array. Migrate the old last error into changelog, then drop `last_error`.
- Changelog entries contain `is_ok`, `timestamp`, `text`, and Ukrainian `description` fields.
- If the latest changelog entry is not OK, show a warning on the palette item.
- Add an `Історія` action in the `/rer-palitra-neo` actions column that opens a popup with the changelog entries.
- Add a retry action in `/rer-palitra-neo` for GOI-origin conversion refresh failures.
- Duplicate Echo-origin mappings for the same GOI remote path block sync for all rows on that remote path.
- For GOI-origin convertible palettes, keep original GOI source data in Echo and use the converted KMZ only as the active Echo palette artifact.
- If a GOI-origin source refresh fails conversion, keep existing Echo files/geometries unchanged, append a warning, and avoid automatic retries for the same GOI source checksum until the checksum changes or a user manually retries.
- When a GOI-side edit wins for an Echo-origin palette, keep `imported_from_goi` unchanged and use `goi_palitra_sync.direction` for ownership behavior.
- Frequency import regression coverage should be a functest if practical.
- Sync state-machine decisions should be extracted into pure functions where practical and covered with table-driven tests.
- Replacement conversion jobs must keep regression coverage for stale worker completion.

## Main Code Areas

- `wdintel-rs/src/palitra/goi_sync_worker.rs`
- `wdintel-rs/src/palitra/conversion_worker.rs`
- `wdintel-rs/src/palitra/mod.rs`
- `goi-echo-worker/src/config.rs`
- `goi-echo-worker/src/http_api.rs`
- `/rer-palitra-neo` frontend table/actions/details code

## Checklist

### 1. Add changelog schema and shared types

- [x] Add a pure SQL migration for `goi_palitra_sync.changelog jsonb not null default '[]'::jsonb`.
- [x] Migrate existing `goi_palitra_sync.last_error` values into `changelog` as non-OK entries with system text and Ukrainian user-facing descriptions.
- [x] Drop `goi_palitra_sync.last_error` after migration.
- [ ] Regenerate SeaORM entities with `just gen-seaorm`.
- [x] Add Rust structs for changelog entries with fields `is_ok`, `timestamp`, `text`, and `description`.
- [x] Add helper functions to append OK/error changelog entries without overwriting prior history.
- [x] Add helpers for latest changelog entry and latest warning state.

### 2. Model GOI source files separately from converted Echo palette artifacts

- [x] Add schema representation for GOI source metadata that can track the original remote file independently from the converted Echo palette file.
- [x] Store enough source-file data to re-run conversion and retry failed GOI source refreshes from `/rer-palitra-neo`.
- [x] Preserve the original GOI file bytes/metadata in Echo for convertible GOI imports.
- [x] Keep the converted KMZ as the active Echo palette geometry source.
- [x] Prevent GOI-origin converted KMZ output from being uploaded back to GOI as a new `.kmz` remote file.
- [x] On GOI-side source changes, refresh the stored original file, re-run conversion, and update the existing Echo palette geometries from the new converted output.
- [x] If conversion fails after a GOI-side source update, keep existing Echo geometries unchanged and append a non-OK changelog entry tied to that GOI source version.
- [x] Use stored GOI source metadata/checksum to avoid retrying the same bad source file automatically until the GOI checksum changes or a user triggers retry.
- [x] Append OK changelog entries for created, synced from GOI, imported new version, converted, synced to GOI, and error fixed events.
- [x] Ensure original-path GOI sync rows are not left in a state that keeps re-processing the same original file after successful converted-artifact import.
- [ ] Add tests for first import, GOI-side source refresh, failed source refresh, user retry, and no converted KMZ upload for GOI-origin source.

### 3. Block Echo-side edits for GOI-owned convertible palettes

- [x] Identify GOI-origin convertible palettes from the new source/conversion tracking state.
- [x] Reject backend mutation APIs that would edit such palettes on the Echo side, except allowed sync/retry/internal worker paths.
- [x] Return a clear error that the palette must be edited in GOI.
- [x] Expose enough metadata to the frontend to show the GOI-owned banner.
- [x] Show a banner on `/rer-palitra-neo` palette details/edit surfaces: `Редагуйте цю палітру в ГОІ`.
- [x] Disable or hide Echo-side edit actions for GOI-owned convertible palettes.
- [ ] Add backend and frontend tests for edit blocking.

### 4. Make GOI convertible import scheduling failure recoverable

- [x] In `import_convertible_goi_palitra_file`, handle conversion scheduling failure after palette creation.
- [x] Mark the palette `conversion_status = error` with the scheduling error when the conversion job cannot be inserted.
- [x] Append a non-OK changelog entry for scheduling failure.
- [ ] Add a regression test that simulates job scheduling failure and verifies the palette does not remain stuck in `processing`.

### 5. Add recovery for processing palettes without live conversion jobs

- [x] Add a conversion-worker reconciliation step for stale `palitra.conversion_status = processing` rows with no live pending/processing conversion job.
- [x] Mark unrecoverable rows as `conversion_status = error` with a diagnostic message after the stale timeout.
- [x] Append a non-OK changelog entry when reconciliation marks a palette failed.
- [x] Flush palette cache when reconciliation changes a palette status.
- [ ] Add tests for stale processing-without-job recovery and non-stale processing rows being left alone.

### 6. Preserve Echo-origin semantics during GOI-side refresh

- [x] Split refresh helpers so GOI-origin refresh can mark/keep `imported_from_goi = true`, while Echo-origin refresh keeps the existing `imported_from_goi` value.
- [x] Use `goi_palitra_sync.direction` as the sync ownership signal for GOI/Echo behavior.
- [x] Add tests proving an Echo-origin palette refreshed from GOI does not become `imported_from_goi = true` unless it already was.

### 7. Handle duplicate Echo-origin rows as remote-path conflicts

- [x] Distinguish duplicate GOI-origin imports from multiple Echo-origin rows mapped to the same GOI remote path.
- [x] For Echo-origin duplicates, block sync for all rows on that GOI remote path.
- [x] Append non-OK changelog entries to every affected row explaining the duplicate remote-path conflict.
- [x] Keep stale deletion behavior only for duplicate GOI-origin imports that are safe to collapse.
- [x] Clear/fix the conflict by appending OK changelog entries once the duplicate mapping is resolved.
- [ ] Add tests for GOI-origin duplicate cleanup and Echo-origin duplicate remote-path blocking.

### 8. Improve checksum conflict diagnostics and sync decisions

- [x] Extract checksum-based sync decision logic into a pure function returning `RefreshEcho`, `PushEcho`, `Noop`, or `Conflict`.
- [x] Include stored Echo checksum, current Echo checksum, stored GOI checksum, and current GOI checksum in the decision input.
- [x] Record specific changelog/error messages for missing Echo checksum metadata, missing/deleted Echo palette, missing Echo S3 file, and current Echo checksum differing from stored Echo checksum.
- [x] Add table-driven unit tests for Echo edit push, GOI edit refresh, no-op, and conflict cases.
- [x] Ensure decisions update side-specific checksum metadata without creating feedback loops.
- [ ] Apply the pure-decision approach to other GOI sync state-machine branches when it keeps behavior testable without large integration setup.

### 9. Add `/rer-palitra-neo` changelog UI

- [x] Add changelog fields to backend palette list/detail DTOs and Elm/TS bindings via `wdintel-rs/src/elm.rs` plus `just gen-front`.
- [x] Display a warning indicator on palette rows when the latest changelog entry is non-OK.
- [x] Add an `Історія` row action in `PalitraTable.row-actions.tsx`.
- [x] Implement a popup/dialog that shows changelog entries in reverse chronological order with status, timestamp, Ukrainian description, and technical text when useful.
- [x] Handle API errors with visible toasts.
- [ ] Add frontend tests for warning display and history dialog.

### 10. Add GOI source refresh retry action

- [x] Add backend endpoint or extend the existing retry endpoint to retry the latest failed GOI source conversion refresh for a palette.
- [x] Reuse stored original GOI source bytes/metadata; do not require the GOI checksum to change for manual retry.
- [x] Append OK/non-OK changelog entries for retry started, retry succeeded, and retry failed.
- [x] Add a `/rer-palitra-neo` row action for retry when latest state is a GOI source conversion failure.
- [x] Refresh table data and show success/error toasts after retry.
- [ ] Add backend and frontend tests for retry visibility and execution.

### 11. Add GOI frequency readonly endpoint regression coverage

- [x] Add an HTTP/API-level or functest-based test for `/api/frequencies/signed/import`.
- [x] Use a temp xlsx directory containing both `frequencies.xlsx` and `frequencies-readonly.xlsx`.
- [x] Assert the import writes only to `frequencies-readonly.xlsx` and leaves `frequencies.xlsx` unchanged.
- [x] Assert the response reports the readonly path.

### 12. Add replacement conversion race regression coverage

- [ ] Add a test where attempt 1 starts, a replacement upload is scheduled, and the replacement is picked as a later attempt.
- [ ] Verify stale attempt 1 completion cannot update palette geometries, mark the job done, or schedule a GOI upload.
- [ ] Keep the existing `attempt_count` guard behavior covered so future edits do not reintroduce the race.

### 13. Verification

- [ ] Run `just migrate-up` for new migrations.
- [ ] Run `just gen-seaorm` after schema changes.
- [x] Run `just gen-front` after DTO/binding changes.
- [x] Run `cargo fmt`.
- [x] Run focused Rust tests for palette conversion and GOI sync modules.
- [x] Run GOI worker tests or functests covering frequency import.
- [x] Run relevant frontend tests.
- [x] Run `cd wdintel-web && npm run format:staged` after frontend edits.
- [x] Run `just build-front`.
- [x] Run `cargo clippy --release --all-targets --all-features -- -D warnings`.
- [x] Run `git diff --check` on modified files.

## QnA

No pending questions.
