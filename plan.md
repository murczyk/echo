# Etalonka report start-date normalization handoff

## Requested behavior

- For an extended etalonka report without a `since` timestamp, use one year before the report end timestamp.
- Clamp any resulting or supplied `since` timestamp earlier than `2022-01-01T00:00:00Z` to that date.

## Current implementation

Uncommitted changes exist in:

- `wdintel-rs/src/config.rs`
  - Added `RER_ETALONKA_REPORT_SINCE_DEFAULT_DAYS = 365`.
  - Added `RER_ETALONKA_REPORT_SINCE_MIN_MS = 1_640_995_200_000`.
- `wdintel-rs/src/sigint/etalonka/types.rs`
  - Added `#[serde(default)]` to `EtalonkaExtendedSettings::since_date_inclusive_ms`, so an omitted JSON field deserializes as `0`.
- `wdintel-rs/src/sigint/etalonka/mod.rs`
  - In `etalonka_collection_options`, `since_date_inclusive_ms == 0` is treated as missing and replaced with `till_ms - 365 days`.
  - The start is then clamped to `RER_ETALONKA_REPORT_SINCE_MIN_MS`.
  - Updated the existing chunk-boundary test to use dates after 2022.
  - Added tests for the one-year default and the 2022 clamp.

No commit or push was performed.

## Validation completed

- `cargo fmt --all` completed successfully.
- `git diff --check` completed successfully.
- The filtered Rust test target compiled successfully.

## Validation blocker

`cargo test -p wdintel-rs sigint::etalonka::tests::extended_report_` aborted in the global test initializer before running the filtered tests. The existing default test database has an incomplete migration baseline: migration `m20231226_134526_index_sigint_comment_signal_message_id` failed because relation `sigint_comment` does not exist.

An attempt to prepare the standard test database with:

```bash
XDG_RUNTIME_DIR=/tmp TEST_DB_NAME=wd_test_codex_etalonka_since_20260813 just setup-test-db
```

stalled while waiting for PostgreSQL and is no longer running.

## Remaining work

1. Restore/create a valid dedicated test database from the standard dump, following the repository test-database setup.
2. Run the focused tests with that database:

   ```bash
   TEST_DB_NAME=<valid-test-db> cargo test -p wdintel-rs sigint::etalonka::tests::extended_report_
   ```

3. Run required backend checks:

   ```bash
   cargo check -p wdintel-rs
   cargo clippy -p wdintel-rs --all-targets
   ```

4. Review `git diff` and `git status`; do not commit or push without explicit user permission.

## Review note

The implementation interprets “one year” as exactly 365 days before the selected report end (`till_ms`), not a calendar-year subtraction. It treats only `0`/an omitted field as missing. Requests whose end timestamp itself predates 2022 will still become an invalid period after the required start-date clamp; the current UI already restricts dates to 2022 or later.
