# Reports History Plan

## Scope

Add durable report history for every user-facing report-producing flow:

- `rer-analysis-neo` report constructor reports.
- Legacy `/rer-analysis` report constructor reports.
- `rer-analysis-neo` and legacy analysis exports: summary table, KMZ, GeoJSON.
- `rer-networks-neo` etalonka reports.
- Legacy `/rer-networks` etalonka reports.
- GOI report download.

Add a new current-user-only settings tab:

- Navbar: `Налаштування -> Мої Звіти (бета)` as the last settings tab.
- URL: `/settings-neo?section=myReports`.
- Table columns: report kind using UI labels, requested timestamp, status, completed timestamp, action.
- Action rules:
  - `done` with S3 object key: download icon enabled.
  - `done` without S3 object key, including migrated missing legacy files: download icon disabled.
  - `failed`: retry icon using a circular-arrow icon; retry reuses the failed row for another attempt.
  - `planned` / `in_progress`: no download; status shows queue/progress state.

Add report-history links from all relevant dialogs:

- `rer-analysis-neo` report builder.
- Legacy `/rer-analysis` report builder if it has matching UI.
- `rer-networks-neo` etalonka report dialog.
- Legacy `/rer-networks` etalonka report dialog if it has matching UI.

Move generation to a durable `report_history` queue with automatic retry and re-download support. Implement workers in the `wdintel-rs-bgworker` process, not the main web-server process.

Split work into:

- PR 1: database table and generated SeaORM entity only.
- PR 2: backend queue/workers/API, legacy-log migration/backfill, and frontend UI.

## Resolved Decisions

- Use `requested_by`, not the misspelled `requsted_by`.
- Store encrypted S3 object keys through backend download, not public URLs.
- Rename the requested `s3_url` column to a consistency-oriented name, proposed as `s3_id`.
- Use the same StrongBox/S3 security model as existing media assets.
- Migrate old `log_users_report_generation` rows into `report_history`.
- Upload old local report files to S3 when the file still exists.
- For missing old files, keep `s3_id = null` and disable download in the UI.
- Deprecate `log_users_report_generation` after migration and drop it in a later migration.
- Use 4 total attempts: 1 initial attempt plus 3 retries.
- Set `completed_at` for both `done` and `failed`.
- Keep this page current-user-only, including for admins.
- Keep report history/files indefinitely until a separate cleanup policy is requested.
- Preserve UI-generated filenames where possible.
- Auto-refresh the history table every 5 seconds while any visible row is `planned` or `in_progress`.
- Use one worker per report kind and no extra global concurrency limit initially.
- Show only `Помилка` in the web UI for failed reports; keep detailed errors backend-side only.
- Add backend-only report history `log` storage; do not expose it in the web UI.
- Manual retry of a failed report requeues the same `report_history` row and appends a backend log entry with user login, timestamp, and message.
- Preserve existing direct-file endpoint response contracts for non-UI/API callers.
- Direct endpoints should also write a history row when practical.
- Run legacy-log backfill automatically on bgworker startup, slowly, one file every 15 seconds, and stop when no work remains.

## Current Code Map

- Existing report log table migration: `echo-migration/src/m20250408_073547_add_log_users_report_generation_table.rs`.
- Existing report log entity: `wdintel-rs/src/entities/log_users_report_generation.rs`.
- Analysis report endpoints and local `reports_log` storage: `wdintel-rs/src/rer_importer/reports/mod.rs`.
- Analysis report request/types: `wdintel-rs/src/rer_importer/reports/types.rs`.
- Analysis export endpoints/services: `wdintel-rs/src/rer_importer/analysis/*`.
- Etalonka async report endpoints: `wdintel-rs/src/sigint/etalonka/task.rs`.
- Etalonka request/types: `wdintel-rs/src/sigint/etalonka/types.rs`.
- GOI report endpoint: `wdintel-rs/src/sigint/network/*`.
- Generic background task progress: `wdintel-rs/src/delta/mod.rs`, `wdintel-rs/src/entities/bgtask.rs`, `wdintel-rs/src/entities/bgtask_res.rs`.
- S3 encrypted object helpers: `wdintel-rs/src/storage.rs`, `wdintel-rs/src/messenger/media.rs`.
- Background worker registration: `wdintel-rs/src/server/mod.rs`, especially `main_bgworker`.
- Type generation registry: `wdintel-rs/src/elm.rs`.
- React report builder dialog: `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/AnalysisReportDialog.tsx`.
- React report builder state/API flow: `wdintel-web/src/ts/react/routes/rer-analysis-neo/use-analysis-report.ts`.
- React report labels/request helpers: `wdintel-web/src/ts/react/routes/rer-analysis-neo/report-helpers.ts`.
- React etalonka report dialog/actions: `wdintel-web/src/ts/react/routes/rer-networks-neo/use-rer-networks-neo-page.reports.ts`, `wdintel-web/src/ts/react/routes/rer-network-details-neo/components/NetworkEtalonkaReportDialog.tsx`.
- Legacy Elm report calls: `wdintel-web/src/Effect.elm`.
- Navbar menu: `wdintel-web/src/Shared/Components/Navbar.elm`.
- Elm route shells: `wdintel-web/src/Pages/*.elm`.
- Shared table pattern: `wdintel-web/src/ts/react/routes/admin-users-neo/index.tsx`.

## Proposed Data Model

Create `report_history` with requested columns plus operational columns needed for queueing, progress, migration, and download:

- `id bigserial primary key`
- `report_kind text not null`
- `requested_by text not null references login(login)`
- `request jsonb not null`
- `created_at timestamp without time zone default (now() at time zone 'utc') not null`
- `status text not null default 'planned'`
- `retry_count integer not null default 0`
- `planned_for_ts timestamp without time zone`
- `started_at timestamp without time zone`
- `completed_at timestamp without time zone`
- `s3_id text`
- `bgtask_id bigint references bgtask(id)`
- `file_name text`
- `content_type text`
- `last_error text`
- `log jsonb not null default '[]'::jsonb`
- `legacy_log_id bigint unique`
- `legacy_report_path text`

Use `request` as a tagged JSON payload, for example:

- `{ "source": "analysis_report", "payload": ReportPreviewReq }`
- `{ "source": "analysis_export", "export_kind": "summary_table" | "kmz" | "geojson", "payload": AnalysisStatsReq }`
- `{ "source": "etalonka_filter", "payload": EtalonkaJimForksReq }`
- `{ "source": "etalonka_batch", "payload": EtalonkaNetworkBatchReq }`
- `{ "source": "goi_report", "payload": {} }`
- `{ "source": "legacy_log", "payload": ..., "raw_report_query": ... }`

Report kind values should be stable backend values that are mapped to UI labels, for example:

- analysis report kinds: existing values such as `tags`, `pelengs`, `babak`, `interception`, `senders`, `posts`, `posts_docx`, `mouse`, `reo`, `digest`, `active_networks`, `network_frequencies`, `report_1213`
- exports: `summary_table`, `kmz`, `geojson`
- etalonka: `etalonka`
- GOI: `goi`
- fallback migrated row: `legacy`

Add constraints/indexes:

- Status check: `planned`, `in_progress`, `failed`, `done`.
- Retry count check: `retry_count >= 0 and retry_count <= 3`.
- User history index: `(requested_by, created_at desc)`.
- Queue pickup partial index: `(report_kind, planned_for_ts, created_at, id) where status = 'planned'`.
- Startup triage partial index: `(id) where status = 'in_progress'`.
- `bgtask_id` index for status joins.
- `legacy_log_id` unique index for idempotent migration/backfill.

## PR 1: DB-Only Plan

- [x] Add migration under `echo-migration/src`, using current local timestamp: `m20260616_153800_create_report_history.rs`.
- [x] Use pure SQL migration style.
- [x] Create `report_history` with the proposed schema, constraints, and indexes.
- [x] Add migration module and `Box::new(...)` entry in `echo-migration/src/lib.rs`.
- [x] Do not mutate, backfill, or drop `log_users_report_generation` in this PR.
- [ ] Apply migration locally with `just migrate-up` after review.
- [x] Generate SeaORM entity with `just gen-seaorm` after review.
- [x] Run `cargo fmt` after review.
- [x] Run `cargo check` after review.
- [ ] Commit only after explicit permission.

## PR 2: Backend Queue Plan

1. Add a backend report-history module, likely `wdintel-rs/src/report_history`.
2. Define Rust/API types:
   - `ReportHistoryStatus`
   - `ReportHistoryKind`
   - `ReportHistoryRequest`
   - list response row DTO for the history page
   - status response DTO for queued/in-progress/done/failed progress
   - download request by `report_history.id`
   - retry request by `report_history.id`
3. Add generated frontend bindings in `wdintel-rs/src/elm.rs`, then run `just gen-front`.
4. Add report-history APIs:
   - list current user's reports
   - get one report status
   - download completed report
   - retry failed report
5. Add queue launch APIs/adapters for all report producers:
   - analysis constructor reports from React and legacy Elm
   - analysis exports: summary table, KMZ, GeoJSON
   - etalonka reports from React and legacy Elm
   - GOI report download
6. Preserve existing direct-file endpoint compatibility where practical, but route UI flows through queued endpoints.
7. Refactor report generation so workers can reuse existing generators:
   - Analysis constructor reports: extract the kind dispatch currently in `wdintel-rs/src/rer_importer/reports/mod.rs`.
   - Analysis exports: extract current direct endpoint generation into reusable byte/file-producing functions.
   - Etalonka: reuse `bl_etalonka_report_networks_data`, `bl_etalonka_report_networks_batch_id_data`, and docx rendering.
   - GOI: extract current GOI report generation into a reusable worker function.
8. On queue launch, create `report_history` row with `planned` status and return `report_history.id`.
9. Status API behavior:
   - `planned`: return queued state; frontend displays `В черзі...`.
   - `in_progress`: include `bgtask_id` and logs/progress.
   - `done`: include download readiness and whether `s3_id` exists.
   - `failed`: return failed state; do not expose backend error details to web UI.
10. Download API behavior:
   - Authenticate `Rer`.
   - Require `requested_by == current_login`.
   - Require `status == done`.
   - Require `s3_id is not null`.
   - Load bytes from encrypted S3 object key.
   - Return attachment with stored `file_name` and `content_type`.
11. Retry API behavior:
   - Authenticate `Rer`.
   - Require `requested_by == current_login`.
   - Require `status == failed`.
   - Append `{ login, timestamp, message: "user requested another attempt for a failed task" }` to `log`.
   - Requeue the same row with status `planned`, clear terminal error/progress fields needed for the next attempt, and reset automatic retry scheduling.
12. Register workers in `main_bgworker` / `wdintel-rs-bgworker`.
13. Do not register report workers in the main web server's live background workers.
14. Startup triage in bgworker:
   - Set any `in_progress` rows back to `planned`.
   - Keep `retry_count` unchanged.
   - Clear stale `bgtask_id` or mark the old `bgtask` failed.
15. Worker loop:
   - Spawn one worker per `report_kind`.
   - Each loop claims the oldest due row for that kind using `for update skip locked`.
   - Ignore planned rows with `planned_for_ts` in the future.
   - Sleep 5 seconds when no row is available.
16. Processing:
   - Create a `bgtask` when a row becomes `in_progress`.
   - Reuse current `bgtask_log` stages for progress.
   - Generate report to temp file or bytes.
   - Upload report bytes to encrypted S3 under a `reports` object-key prefix.
   - Update row to `done`, set `completed_at`, `s3_id`, `file_name`, `content_type`.
17. Automatic retry behavior:
   - `retry_count` counts retries already scheduled/used, not total attempts.
   - Initial attempt starts with `retry_count = 0`.
   - On failure with `retry_count < 3`, increment `retry_count`, set status back to `planned`, and set `planned_for_ts = now + interval '5 minutes' * retry_count`.
   - On failure with `retry_count >= 3`, set status `failed`, `completed_at`, and `last_error`.
18. Existing report log migration/backfill:
   - Run automatically on `wdintel-rs-bgworker` startup.
   - Check whether there are legacy files/rows left to migrate.
   - Migrate one legacy row/file at a time.
   - Sleep 15 seconds between files.
   - Stop the backfill task when no rows remain; do not keep polling for new legacy rows.
   - For every `log_users_report_generation` row not yet linked by `legacy_log_id`, insert a `report_history` row.
   - Preserve `login`, `created_at`, `report_query`, and `report_path`.
   - Infer `report_kind` from `report_query` when possible; otherwise use `legacy`.
   - Use status `done`.
   - Use `completed_at = created_at` unless better information is available.
   - If the local file exists, upload it to encrypted S3 under `reports` and set `s3_id`.
   - If the local file is missing, leave `s3_id = null`.
19. Stop writing new rows to `log_users_report_generation` after queue migration is live.
20. Preserve existing direct-file endpoint contracts; when direct endpoints are called directly, also create history rows when practical.
21. Ensure `cleanup_old_reports_nofail` does not delete or deprecate new `report_history` rows or S3 files.
22. Drop `log_users_report_generation` in a later migration after backfill has been verified.

## Current Resume Status

- [x] Added generated `report_history` SeaORM entity and registered frontend bindings for `ReportHistoryRow` and `ReportHistoryIdReq`.
- [x] Added backend `report_history` module with list, status, download, retry, enqueue, worker claim, S3 upload/download, retry scheduling, and bgworker startup reset.
- [x] Changed analysis report constructor task launch to create `report_history` rows and changed its React-compatible task status/download path to use report-history APIs.
- [x] Changed etalonka task launch endpoints to create `report_history` rows and changed React-compatible task status/download path to use report-history APIs.
- [x] Added queued GOI launch endpoint and partially changed React GOI flow to queue, poll, and download through report history.
- [x] Regenerated frontend bindings with `just gen-front`.
- [x] Verified backend with `cargo check -p wdintel-rs`.
- [x] Wire `SettingsMyReportsSection` into `settings-neo` as the last tab: `myReports`.
- [x] Finish TypeScript compile cleanup for the new report-history API client and partially updated React flows.
- [x] Add report-history links in analysis and etalonka dialogs pointing to `/settings-neo?section=myReports`.
- [x] Implement analysis exports queueing: summary table, KMZ, GeoJSON.
- [x] Extracted summary table, KMZ, and GeoJSON generators into worker-reusable byte functions while preserving direct download endpoints.
- [x] Added queued launch endpoints for summary table, KMZ, and GeoJSON and wired React exports to poll/download through report history.
- [x] Legacy `/rer-analysis` direct report/export endpoints now create completed report-history rows after successful generation.
- [x] Added My Reports links to legacy `/rer-analysis` report/export controls.
- [ ] Implement legacy Elm flow updates and legacy log backfill.
- [x] Add history rows for direct endpoint callers where still practical.
- [x] Run frontend build checks.
- [ ] Add focused tests for report history UI and queued React flows.

## PR 2: Frontend Plan

1. Add a new React settings section, likely reusing `wdintel-web/src/ts/react/routes/settings-neo`, for the `myReports` tab.
2. Reuse the existing `settings-neo` web component instead of adding a dedicated wrapper.
3. No new web component import is needed; `settings-neo` is already imported in `wdintel-web/src/interop.ts`.
4. Reuse the existing Elm `SettingsNeo` route shell.
5. Add `Мої Звіти (бета)` as the last tab in the SettingsNeo tab list:
   - Label: `Мої Звіти (бета)`
   - Section name: `myReports`
   - Path: `/settings-neo?section=myReports`
6. Build the history table with the same table stack used by `admin-users-neo`:
   - `TableStateProvider`
   - `TablePageToolbar`
   - `TableContentState`
   - `MaterialReactTable`
   - shared MRT defaults/styles
7. Table columns:
   - Kind: UI label, not raw DB kind.
   - Reported at: localized timestamp.
   - Status: localized status chip/text.
   - Completed at: localized timestamp or empty.
   - Action: download/retry/disabled based on row state.
8. Add `wdintel-web/src/ts/react/services/api/report-history.ts`.
9. Add display mappers:
   - Analysis constructor kinds reuse labels from `report-helpers.ts`.
   - Export kinds map to `Підсумкова таблиця`, `KMZ`, `GeoJSON`.
   - Etalonka maps to `Еталонний опис`.
   - GOI maps to `Звіт ГОІ`.
   - Legacy fallback maps to `Звіт`.
   - Status labels:
     - `planned` -> `В черзі`
     - `in_progress` -> `Формується`
     - `done` -> `Готово`
     - `failed` -> `Помилка`
10. [x] Update React analysis report builder flow:
    - Launch queue API and poll report-history status.
    - Show `В черзі...` before status becomes `in_progress`.
    - Start progress UI only when `in_progress`.
    - Auto-download after `done` when `s3_id` exists.
    - Re-download remains available from history.
11. [x] Update React analysis exports to use queued generation and history.
12. [x] Update React etalonka report flow:
    - Launch queue API and poll report-history status.
    - Show `В черзі...` before status becomes `in_progress`.
    - Auto-download after `done` when `s3_id` exists.
13. [x] Update GOI report download flow to queue and then auto-download.
14. Update legacy Elm report flows in `wdintel-web/src/Effect.elm` and corresponding pages to use queued launch/status/download where required.
15. [x] Add link under the report template area in `AnalysisReportDialog.tsx`:
    - Text: `Переглядайте свої звіти в Налаштування -> Мої Звіти`
    - Link target: `/settings-neo?section=myReports`
16. [x] Add equivalent link in legacy analysis UI if present.
17. [x] Add the same history link under the etalonka report description in `NetworkEtalonkaReportDialog.tsx`.
18. Add equivalent link in legacy network etalonka UI if present.
19. [x] Auto-refresh the reports settings tab every 5 seconds while visible rows include `planned` or `in_progress`.
20. [x] Do not show backend `last_error` details in the web UI.

## Verification Plan

Backend:

- `cargo fmt`
- `cargo check`
- `cargo clippy`
- Focused tests for:
  - queue launch creates `planned` rows for each producer class
  - queue claim SQL skips locked rows
  - startup triage resets `in_progress`
  - 4-total-attempt retry behavior and retry delays
  - current user cannot list/download/retry another user's report
  - successful worker run stores `done` with encrypted S3 key and metadata
  - `done` rows with null `s3_id` cannot be downloaded
  - old log backfill uploads existing files, leaves missing files with null `s3_id`, sleeps between files, and exits when done
  - manual retry reuses the failed row and appends the backend-only log entry
  - direct legacy endpoints remain compatible and write history when practical

Frontend:

- `cd wdintel-web && elm make src/Pages/MyReports.elm --output=/dev/null`
- `cd wdintel-web && npm run test:ts -- report`
- Focused tests for:
  - report kind/status labels
  - history table download/retry/disabled action states
  - history table auto-refresh condition
  - analysis dialog history link
  - etalonka dialog history link
  - queued status displays `В черзі...`
  - failed status displays only `Помилка`

Full checks:

- `just gen-front`
- `just build-front`

## Risks

- Moving legacy direct endpoints to queued flows can break callers if response contracts change.
- Existing legacy Elm pages may have synchronous file-download assumptions that need careful UI changes.
- Legacy-log backfill can be expensive if many local files still exist and must be uploaded to S3.
- Automatic startup backfill must be throttled so it does not contend with normal bgworker report processing.
- `cleanup_old_reports_nofail` currently deletes local files and marks old log rows deprecated; this must not touch new history/S3 files.
- S3 column naming differs from the original request; `s3_id` is intentional for consistency with existing encrypted media storage.
- Running report workers only in `wdintel-rs-bgworker` means local development must run the bgworker process to process queued reports.
- Old `log_users_report_generation` rows may have unparseable `report_query`; those rows need a fallback UI label and may be retry-ineligible if the request cannot be reconstructed.
