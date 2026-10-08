# #3598 RER report administration plan

## Findings

- [x] Confirmed that `/admin/all-reports?tab=rer-report` fails because `RerReportSettings` calls `usePowerSnackbar()` while `admin-all-reports-element.tsx` does not mount `PowerSnackbarProvider`.
- [x] Confirmed that the system-wide `rer_report_enabled` setting, its admin endpoint, the RER report template, and the `для звіту РЕР` analysis filter already exist.
- [x] Confirmed that filter visibility currently depends only on the system-wide setting; there is no per-user eligibility state or metadata storage yet.
- [x] Confirmed that `3598-rer-report-whitelist` is based on `main`, the appropriate base for this feature and schema/UI extension.

## Implementation checklist

- [x] Restore the RER report tab by wrapping `AdminAllReportsPage` in `PowerSnackbarProvider`; add an issue-linked custom-element regression test that opens `?tab=rer-report` with the real snackbar context and verifies that the enable-RER-report checkbox renders.

- [x] Add a timestamped pure-SQL migration for the proposed dedicated RER-report access list and `sigint_unit_rer_report_metadata`:
  - `rer_report_access_login`: primary key, unique `login_id` foreign key to `login(id)` with cascade deletion, and `created_at`.
  - `sigint_unit_rer_report_metadata`: primary key, unique `sigint_unit_id` foreign key to `sigint_unit(id)` with cascade deletion, JSONB `locations` and `labels` arrays, and `created_at`.
  - Add indexes/constraints for the foreign keys and JSON array shape, register the migration in `echo-migration/src/lib.rs`, and generate the SeaORM entities with `just gen-seaorm`.
  - Treat both tables as PostgreSQL-only configuration/reference data: add them to `deploy/clickhouse/env/tables-exclude.txt` and declare both as `excluded` in `deploy/clickhouse/migration-impact.json`.

- [x] Add generated backend/frontend contracts and admin-only APIs in a focused RER-report administration module:
  - List and replace the eligible login IDs transactionally, validating that referenced logins exist.
  - List metadata rows joined to `sigint_unit`, returning `id`, `sigint_unit_id`, `sigint_unit_name`, `locations`, and `labels` in a stable order.
  - Create, update, and delete metadata rows; accept typed `Vec<String>` values, trim entries, reject empty strings, and deduplicate while preserving order.
  - Require admin authorization for every access-list and metadata mutation/read endpoint, register the endpoints in `server/mod.rs`, export the DTOs from `elm.rs`, and run `just gen-front` rather than hand-writing bindings.

- [x] Expose exact current-user eligibility through `/api/user` (defaulting to false when no access-list row exists), update the React user normalizer, and cover allowlisted/non-allowlisted behavior with database-backed backend tests.

- [x] Extend the RER report admin tab without growing one large component:
  - Keep the existing system enable switch and its loading/error/saving behavior.
  - Add a multi-user selector labelled `Працює над звітом РЕР`, backed by the dedicated access list and existing admin login data, with explicit loading, save, and failure feedback.
  - Add a separate metadata table section using `TableStateProvider`, `TablePageToolbar`, `useAppMaterialReactTable`, and `MaterialReactTable`, matching `/admin/messenger-neo` behavior.
  - Set the visible column order to row numbers, actions, `sigint_unit_name`, `locations`, and `labels`; render both string arrays through `mrtItemsCell` with `EchoChip` label components.
  - Put a `Додати новий` button above the table, use the existing debounced SIGINT-unit search for selection, and provide focused create/edit and delete-confirmation dialogs with toast/inline API errors.
  - Implement edit and delete row actions with `MrtRowActions`/`MrtRowActionButton`, disable duplicate-unit selection when creating, and refresh local table state from successful API responses.

- [x] Gate only the extra `для звіту РЕР` checkbox in `/rer-analysis-neo` on both `rer_report_enabled` and the current user's eligibility; keep the system-wide setting as the report-template gate, clear `onlyWithNetwork` (including its URL state) when the user is not allowed, and test eligible, ineligible, and globally disabled cases.

- [x] Integrate the new unit metadata reference into both synchronous and staged SIGINT-unit merges: move a lone source row to the survivor, merge/deduplicate `locations` and `labels` when both units have rows, remove the source row, include the table in remaining-reference checks, and add a database-backed merge regression so soft-deleted duplicate units cannot strand metadata.

- [x] Extend the existing `CHANGELOG.md` `NEXT` entry for [#3598](https://github.com/echoua/echo/issues/3598) with the restored admin tab, eligible-user control, and metadata table; leave `README.md` and `docs/README.md` unchanged because the system architecture and setup do not change.

- [x] Validate the completed change:
  - [x] Applied the migration, exercised its down/up path, and ran a transactional PostgreSQL CRUD smoke test.
  - [x] Restored the standard test dump and passed the catalog-aware analytics migration check against `main`.
  - [x] Passed focused database tests, 85 issue-linked React tests, TypeScript, `cargo check`, all-target/all-feature Clippy, Prettier, and `just build-front`.
  - [x] Ran the full optimized backend suite: 2,974 tests passed; the remaining environment-dependent failures require unavailable local S3/audio and NLP services, while the isolated device-schema failure reproduces an unrelated PostgreSQL catalog mismatch.
  - [x] Verified the direct-tab provider, switch persistence, eligibility gating/URL cleanup, access-list data flow, metadata CRUD contracts/table rendering, and unit-merge behavior through focused regressions, builds, and database smoke tests.
  - [x] Confirmed all modified Rust files are formatted; the repository-wide format check still reports only pre-existing formatting in `wdintel-rs/src/messenger/worker/mod.rs`.

## Open questions

- [x] Should eligibility use a dedicated `rer_report_access_login` table, and should `Admin` automatically bypass the list?
  - answer: use the dedicated table and require explicit membership for everyone (without an automatic administrator bypass), so the configured list remains the exact source of truth for analysis-filter visibility; hide the analysis checkbox whenever the global RER-report switch is disabled in `/admin/all-reports?tab=rer-report`.
- [x] Which accounts belong in the selector: active users only, or also deactivated, Delta, API, and service accounts?
  - answer: offer active human accounts, including normal users who authenticate through Delta; exclude deleted/deactivated, API, bot, and service accounts. Preserve a previously selected account if it later becomes inactive so an administrator can see and remove the stale entry.
- [x] Does `Працює над звітом РЕР` restrict only the `для звіту РЕР` analysis checkbox, or also the `РЕР Звіт` template and report generation?
  - answer: restrict only the checkbox and clear its hidden URL/query state for ineligible users. Keep report-template availability and generation governed by the existing system-wide `rer_report_enabled` setting because broader authorization was not requested.
- [x] Is metadata strictly one row per SIGINT unit, or may a unit have multiple metadata rows?
  - answer: enforce one row per unit with a unique constraint; when units merge, move the row or union and deduplicate both lists if the survivor already has metadata, preserving all reference data.
- [x] Which row actions and input rules should apply to `locations` and `labels`?
  - answer: provide edit and delete actions, use free-text chip inputs, trim and deduplicate values case-sensitively, allow either individual list to be empty, but require at least one value across the two lists before saving; when creating a new entry - prefill labels with [sigint_unit.name].
