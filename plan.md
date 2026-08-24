# Transcription administration follow-up plan

## Remaining implementation and review

- [ ] Confirm whether table filtering and sorting must apply to the complete result set, as on `/admin/all-reports`. The current React table applies these controls only to the currently loaded page of up to 100 rows; either implement server-side filters/sorting or remove controls that imply global behavior.
- [ ] Add focused backend coverage for the transcription-results list and media endpoints, including admin authorization, disabled-transcriber behavior, pagination, GPU instance-name resolution, timestamps, duration, and nullable/error results.
- [ ] Validate the results query with representative production-scale data and review its query plan. The dedicated test database was too small for a meaningful index-usage assessment.
- [ ] Decide whether historical queue rows with no `started_transcription_at` should remain blank or require a backfill. New processing transitions are already timestamped by the migration trigger.

## Final validation

- [ ] Rerun `cargo fmt`, `cargo check`, and `git diff --check` after the final generated-entity field-order adjustment.
- [ ] Rerun `cargo clippy --all-targets --all-features -- -D warnings` if any further Rust changes are made. It passed before the field-order-only adjustment.
- [ ] Rerun the focused Vitest suite and `just build-front` if any further frontend changes are made. The current frontend tests and build passed.
- [ ] Review the complete `git status` and `git diff` for unintended changes before handoff.

## Migration and generated code

- [ ] Resolve the default local database migration drift: `m20260811_152632_multiple_inbox_unit_links` is recorded as applied but its source file is absent. Then run `just migrate-up` against that database if local-default migration verification is required.
- [ ] Run the normal `just gen-seaorm` workflow against a clean, supported database after resolving the local migration baseline. A targeted generation against the dedicated restored test database already confirmed the queue entity's new field and column order.
- [ ] Run the catalog-aware analytics migration check after the migration changes are committed or in CI. The local script skipped comparison because its migration-change precheck only considered committed changes. The new migration is already declared excluded in `deploy/clickhouse/migration-impact.json`.

## Release and handoff

- [ ] Add a `CHANGELOG.md` entry if this feature requires one. Obtain the GitHub issue number first unless the user explicitly identifies it as a no-ticket hotfix.
- [ ] Show the final diff and status to the user. Do not commit or push without explicit permission.

## Verification already completed

- [x] Focused navigation and transcription-settings Vitest suites passed: 45 tests across 3 files.
- [x] Frontend production build and focused Elm compilation passed.
- [x] `cargo check` and strict `cargo clippy` passed before the final entity field-order-only adjustment.
- [x] The migration applied successfully to a database restored from the standard test dump.
- [x] The `started_transcription_at` trigger behavior was verified transactionally.
- [x] Targeted SeaORM generation confirmed the checked-in queue entity schema.
