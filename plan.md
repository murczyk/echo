# API Integration Synchronization Plan

## Assumption

- A successful connection test sets `is_working = true`. The requirement saying
  to set it to `false` after success is treated as a typo; failures set it to
  `false`.

## Database

- [x] Create a new timestamped pure-SQL migration for `api_integration`.
- [x] Add `sync_enabled boolean not null default false`.
- [x] Add `last_sync_at timestamp without time zone null`.
- [x] Add `is_working boolean not null default false`.
- [x] Add the migration module and registration to `echo-migration/src/lib.rs`.
- [x] Apply the migration locally with `just migrate-up`.
- [x] Regenerate SeaORM entities with `just gen-seaorm`.

## API Integration Backend

- [x] Add synchronization fields to the API integration response type.
- [x] Add `sync_enabled` to the upsert request type.
- [x] Reject/ignore synchronization enablement while creating an integration.
- [x] Persist synchronization changes only through the existing Save action.
- [x] When an existing integration transitions from disabled to enabled, set
  `last_sync_at` to the current UTC timestamp.
- [x] When synchronization is disabled, preserve `last_sync_at` and reset
  `is_working` to `false`.
- [x] Keep worker-owned `last_sync_at` and `is_working` values unchanged during
  ordinary edits.
- [x] Regenerate Elm and TypeScript bindings with `just gen-front`.

## Admin UI

- [x] Add `syncEnabled` to the API integration edit form.
- [x] Show an "Enable synchronization" checkbox only for an existing
  integration.
- [x] Keep the checkbox as unsaved form state until Save is pressed.
- [x] Send `syncEnabled = false` when creating a new integration.
- [x] Disable synchronization unless an Iggy connection is configured.
- [x] Handle save/load API errors through the existing visible alert flow.

## Iggy Package

- [x] Replace the flat `iggy.rs` module with an `iggy/` package.
- [x] Move connection-string creation and connection testing into the package.
- [x] Add reusable client connect/shutdown helpers for the admin endpoint and
  worker.
- [x] Add message publishing support for the configured inbox topic.
- [x] Add analytical-topic polling support that logs received entries at INFO.
- [x] Keep Iggy timeout/retry constants in `config.rs`.

## Iggy Background Worker

- [x] Add `iggy/worker.rs`.
- [x] Register a named Iggy synchronization worker in `wdintel-rs-bgworker`.
- [x] Load integrations where `sync_enabled = true` and Iggy is configured.
- [x] Sleep for one minute when no active integrations exist.
- [x] Process every active integration independently so one failure does not
  block the others.
- [x] For `is_working = false`, test the connection before syncing.
- [x] Set `is_working = true` after a successful test; keep/set it to `false`
  and skip after a failed test.
- [x] Capture `started_at` in UTC before loading messages.
- [x] Load messages visible to the integration's API login using the same
  visibility rules as a regular Rer user on `/rer-duty`.
- [x] Restrict messages to `[last_sync_at, started_at]`.
- [x] Serialize and publish each inbox message to the configured Iggy inbox
  topic.
- [x] Retry a failed publish twice: wait 100 ms before attempt two and one
  second before attempt three.
- [x] After the third publish failure, set `is_working = false` and continue
  with the next integration without advancing `last_sync_at`.
- [x] After all inbox messages publish successfully, set
  `last_sync_at = started_at` and `is_working = true`.
- [x] Poll the configured analytical topic and log each received entry at INFO.
- [x] Make the no-fail worker loop log errors and continue.

## Verification

- [x] Add focused tests for create/update synchronization semantics.
- [x] Add focused tests for retry timing/attempt behavior where practical.
- [x] Run `cargo fmt`.
- [x] Run targeted Rust tests.
- [x] Run `cargo check`.
- [x] Run `cargo clippy`.
- [x] Run the modified frontend checks.
- [x] Run `just build-front`.
- [x] Review `git status` and `git diff`.
