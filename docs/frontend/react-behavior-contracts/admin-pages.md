# Admin page contracts

## Echo native groups

- **Behavior ID:** `admin-native-groups-lifecycle`
- **Affected route:** `/admin/directions-neo`, system administrators only.
- **Expected observable result:** «Створити групу» creates a private Echo Native group, preselecting the creator as an administrator and directly invited user. Empty groups appear immediately. Editing, assigning directions, and removing directions use the same native form, preserving global access settings. Selecting directions requires an AOR; unassigned groups may have no AOR.
- **Access:** successful creation and the creator's message visibility are reported separately. Group administration does not grant message-reading access. Messenger ingestion controls are absent; network/category controls retain their existing meaning. Native forms support the shared group-color picker; updates that omit the color retain the current value.
- **Archive:** archived native groups expose read-only settings. Restoring returns the group to the unassigned list without restoring directions.
- **Loading/error/success behavior:** API failures display a dismissible toast and preserve the form. Successful save closes the form before refreshing lists and checking access, so a follow-up failure cannot be presented as failed creation.
- **Known race/idempotency constraints:** retries within the open creation form use the same operation UUID, including when the server saved a group but its response was lost. Forms cannot be dismissed while saving.
- **API:** generated contracts for `/api/messenger/native-groups/create`, `/get`, `/update`; existing archive/unarchive endpoints.
- **Source implementation:** `wdintel-web/src/ts/react/routes/admin-directions-neo/NativeGroupDialog.tsx`, `wdintel-web/src/ts/react/routes/admin-directions-neo/index.tsx`.
- **Existing tests:** `wdintel-web/tests/e2e/admin-native-groups.spec.ts`, `wdintel-web/tests/e2e/admin-group-ingestion.spec.ts`.
- **Original Echo issue:** https://github.com/echoua/echo/issues/3646.

## KPI dashboard

- **Issue:** [#3826](https://github.com/echoua/echo/issues/3826).
- **Route and access:** `/admin/kpi`, the last entry in `Адмін → База знань`, requires Admin. The Elm page checks the role before mounting its React host, including while the shared identity is the anonymous placeholder. Existing `/api/logins` and `/api/admin/report-history/list` retain backend admin enforcement.
- **Account scope:** unique current account IDs from `/api/logins`, including technical accounts but excluding the permanently deleted/managed accounts omitted by that API. Role and organism filters affect every account metric, distribution, and review row. Role membership can contribute to multiple bars; repeated identical roles contribute once. Organisms and directions are grouped by IDs.
- **Status and recency:** account deactivation and reason take precedence over a disabled organism; otherwise the account is active. Recency uses one successful-response timestamp and elapsed UTC milliseconds: less than 30 days, 30–90 inclusive, over 90, no recorded timestamp, or invalid/future timestamp. Recency defaults to deactivated/blocked accounts, with an explicit switch to include active accounts. A recorded timestamp does not establish a login or deliberate human activity.
- **Reports:** a separate system-wide card uses the `done` filter and `total` returned with `limit: 1`; it counts retained successful history records, independently of account filters. It does not count downloads or every generation attempt. Analytics replication can affect freshness.
- **Loading/errors:** sources load and retry independently; failures produce Ukrainian toasts and persistent section errors. Previously loaded values retain their original update timestamps and are explicitly labelled as previous data after refresh failure. Stale or unmounted requests cannot overwrite snapshots. Shared API 401 handling preserves the login redirect.
- **Charts and review:** existing ECharts loads lazily, follows light/dark semantic colors, resizes with its host, and is disposed on cleanup. Accessible tables expose every exact count, even if a chart fails; charts show at most ten groups. Stale accounts are shown in batches of twenty with links to existing user details; KPI provides no account mutation controls.
- **Tabs:** four sections with implemented metrics follow `archive/2026-10-22-kpis/idea.md` in order. The selected section is `?tab=accounts|activity|speed|quality`; invalid values, including removed sections, select accounts. Browser Back restores the selection; account filters survive tab switches. MUI tabs scroll on narrow screens and support keyboard navigation.
- **History APIs:** admin-only `POST /api/kpi/reports`, `/api/kpi/notifications`, `/api/kpi/activity`, and `/api/kpi/requests` accept UTC millisecond `{since, until}` with a half-open interval, an end up to `KPI_MAX_CLOCK_SKEW_SECONDS` (currently 300 seconds) ahead of server time, and a maximum of 90 days. UI presets are 7/30/90 days. History sources load only on their relevant tab and retry independently. Response periods remain visible when a failed reload retains older data; stale responses cannot overwrite a new period.
- **Report aggregation:** PostgreSQL aggregates retained rows created in the period; counts by kind/author/day include only `done`. Retry counts do not multiply rows. Any legacy-linked history row counts once; the separate legacy journal is not added and no legacy backfill or complete reconciliation is established. Generation median/p90 use nonnegative `completed_at - started_at` only for successful worker rows with a background-task ID and no legacy-log link. Synchronous completion, file archival, and legacy timestamps do not establish generation duration and are excluded from samples while remaining in counts. Sample/exclusion counts are exposed; no samples means unavailable. Worker durations include storing the result, exclude queue time, and do not represent every retry separately.
- **Observations and quality:** optional Greptime queries isolate the configured host and requested time interval, cap returned groups, and use timeouts. Unconfigured or empty telemetry is unavailable, never a zero engagement/error rate. Page observations include keep-alives and technical accounts, and do not claim human DAU, sessions, clicks, or adoption. Non-UUID historical identities are excluded and counted as unmapped groups. Missing days are not zero-filled. Queue counters cover this process since startup and do not prove historical completeness. API error percentage is `(4xx + 5xx) / recorded API responses`; initial request events are excluded, middleware error events are included, and duplicate request IDs within one status are counted once. Messenger notification metrics cover retained transport jobs only; `sent` is not a device-delivery/read receipt.
- **API-quality batching:** the browser loads `/api/kpi/requests` sequentially in adjacent half-open slices of at most six hours, summing response/error totals and merging status counts in memory. The displayed period remains the full selection. Configured empty slices return `available: false` with zero counts and contribute no samples; an entirely empty selection stays unavailable. An unavailable source returns unknown (`null`) counts, stops the series immediately, and leaves the full selection unavailable without partial totals. Results are published only after every required slice succeeds; failures retain the previous complete snapshot and period. Changing the period, refreshing, or leaving the tab aborts the unfinished series. Exporter retries preserve original event timestamps, so duplicate copies remain in the same slice for backend request-ID deduplication.
- **Undefined metrics:** missing evidence and definitions are documented in [Iteration 2](../../../archive/2026-10-22-kpis/iteration2.md), without dashboard blocks or tabs containing only these notes. Login problems, onboarding, feature adoption, retention, channels/bots, and referrals remain deferred, along with unsupported metrics within the four visible sections.
- **Iteration scope:** [Iteration 1](../../../archive/2026-10-22-kpis/iteration1.md) and [Iteration 2](../../../archive/2026-10-22-kpis/iteration2.md) record supported definitions and deferred metrics. Estimated live base, verified never-login counts, DAU/WAU/MAU, and other historical/unsupported metrics are deferred.
- **Source:** `wdintel-web/src/Pages/Admin/Kpi.elm`, `wdintel-web/src/ts/react/routes/admin-kpi/`.
- **Tests:** `wdintel-web/tests/e2e/admin-kpi.spec.ts`.

## Admin Unparsed Units

- **Status:** inferred characterization
- **Behavior ID:** `admin-unparsed-units-workflow`
- **Affected route/component:** Admin Unparsed Units.
- **Expected observable result:** messages are paginated five at a time and “Load more” disappears after the final page. The label can be linked through the shared unit-selection workflow; unit creation opens `/rer-units-neo?create=true`; a successful resolution produces visible confirmation.
- **Known race/idempotency constraints:** a stale response cannot replace the current result.
- **Source implementation:** `routes/admin-unparsed-units/index.tsx`.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/admin-unparsed-units/__tests__/index.spec.tsx`
- **Other behavior coverage:** Pagination, linking, create navigation, and success confirmation: No direct default-suite test; behavior is preserved by this contract.

## AI engine eligibility and token transport

- **Status:** security compatibility
- **Behavior ID:** `admin-ai-engine-eligibility`
- **Expected observable result:** direct internal providers require an allowed HTTP `/v1` URL without credentials, query, or fragment; trusted gateway providers require their token and explain the difference between gateway and direct-container transport.
- **Source implementation:** `wdintel-web/src/ts/react/routes/admin-ai-agent/engine-eligibility.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/admin-ai-agent/__tests__/engine-eligibility.spec.ts`

## AI request history pagination

- **Affected route:** `/admin/ai/requests` (administrators only).
- **Expected observable result:** the server returns 20 requests per page. “SHOW MORE” appends the next page; numbered navigation replaces the entries. The final page can contain fewer than 20 entries and hides “SHOW MORE”. Refresh returns to the newest page.
- **API:** `/api/admin/ai-agent/requests/list` fetches at most 21 requests and returns 20 items plus at most two `pageStartIds`: the current and next page boundaries. Subsequent requests pass `pageStartId`; numbered navigation discovers one additional page at a time. `total` is available only when the initial page contains the entire history. Requests use descending UUIDv7 creation order and inclusive page boundaries, so new requests do not shift previously established pages. Search, column filters, and sorting apply to the loaded entries.
- **Loading/error behavior:** pagination is disabled while loading; failures preserve existing entries, show an error toast, and allow retry. Stale responses cannot replace current entries. Request deep links open independently of the displayed page.
- **Source implementation:** `wdintel-rs/src/ai_agent/admin.rs`, `wdintel-web/src/ts/react/routes/admin-ai-agent/index.tsx`.
- **Existing tests:** `wdintel-web/tests/e2e/admin-ai-requests.spec.ts`.

## Intelligence-report settings and attempt pagination

- **Affected route:** `/admin/ai/intelligence-reports` (administrators only).
- **Expected observable result:** every configured model has an editable token budget (512 by default), with radio buttons selecting distinct primary and optional fallback engines. Unavailable engines remain visible but cannot be selected. Budgets survive model selection changes and save/reload. Primary, fallback, and total timeouts are editable (twenty seconds by default); the overall deadline includes both calls and preparation. The server validates positive integer limits, up to 32,768 tokens and 180 seconds. Older save requests preserve optional settings.
- **Fallback behavior:** a failed primary attempt invokes the configured fallback once while time remains before the overall deadline. Failures include token exhaustion (`finish_reason=length`, including an empty response), HTTP or connection errors, attempt timeouts, malformed responses, and content validation failures. A successful primary response skips fallback; without a configured fallback the primary error is returned. Fallback uses its own token budget and attempt timeout, bounded by the remaining overall time; any fallback failure ends generation without a third attempt.
- **Pagination:** twenty attempts per page; each request fetches at most 21 attempts and returns at most two `pageStartIds` for the current and next pages. “SHOW MORE” appends, numbered navigation replaces entries and discovers one additional page at a time, refresh returns to the newest page, and the last page hides “SHOW MORE”. `total` is available only when the initial page contains the entire history. Attempts use descending `(created_at, id)` order with inclusive server page boundaries; new attempts do not shift existing boundaries. Search, sorting, and column filters apply to loaded entries.
- **Loading/error behavior:** pagination is disabled while loading; failed requests preserve entries and allow retry, and stale responses cannot overwrite the current page. Save failures preserve editable limits and show an error toast.
- **Source implementation:** `wdintel-rs/src/ai_intel_report/attempts.rs`, `wdintel-web/src/ts/react/routes/admin-ai-intel-reports/index.tsx`.
- **Existing tests:** `wdintel-web/tests/e2e/admin-ai-intel-reports.spec.ts`, `wdintel-rs/src/ai_intel_report/settings_tests.rs`, `wdintel-rs/src/ai_intel_report/retry_tests.rs`.

## API integration deletion

- **Status:** inferred characterization
- **Behavior ID:** `admin-api-integration-delete-confirmation`
- **Affected route/component:** API Integrations administration page
- **User role or permission:** administrators permitted to delete API integrations
- **Preconditions:** an existing integration is shown in its action menu
- **User action or external event:** the user chooses Delete and confirms the dialog
- **Expected observable result:** no deletion occurs before confirmation; confirmation deletes the selected integration ID and removes it from the page.
- **Loading/empty/error/success behavior:** the row remains visible until deletion succeeds.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** the mutation carries the selected integration ID.
- **Responsive and keyboard requirements:** the overflow menu and confirmation dialog remain accessible.
- **Known race/idempotency constraints:** the confirmation action must remain associated with the selected row.
- **Source implementation:** `src/ts/react/routes/admin-api-integrations/index.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/admin-api-integrations/__tests__/index.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as a destructive-action safeguard.

## GOI integration drawer lifecycle

- **Status:** issue-backed regression — https://github.com/echoua/echo/pull/3268

**Behavior ID:** `admin-goi-integration-drawer-lifecycle`

- **Affected route/component:** `/admin/goi-integrations-neo`, `AdminGoiIntegrationsNeoPage`.
- **User role or permission:** GOI administrator with edit access.
- **Preconditions:** an existing integration is selected for editing.
- **User action or external event:** edit fields, dismiss the drawer, check a connection, or configure its worker.
- **Expected observable result:** dirty dismissal asks before losing edits; a busy connection check disables dismissal; a successful worker setup keeps the drawer open and shows the returned credentials/configuration.
- **Loading/empty/error/success behavior:** validation, connection, save, and worker errors remain visible in the open drawer; worker setup success displays its contextual success message.
- **Persistence:** the drawer baseline is the selected integration form. After successful worker setup it is replaced with the exact returned form, so an unchanged follow-up close does not ask for confirmation.
- **API compatibility:** preserves `/api/admin/goi/integration/upsert`, `/api/admin/goi/check-connection`, and `/api/admin/goi/integration/setup-worker` request/response mappings.
- **Responsive and keyboard requirements:** the right drawer scrolls its form independently; its fixed footer stacks full-width actions at `xs` and is right-aligned at `sm`.
- **Known race/idempotency constraints:** save/check/setup disable dismissal while in flight; a failed worker setup must not advance the baseline.
- **Source implementation:** `wdintel-web/src/ts/react/routes/admin-goi-integrations-neo/index.tsx`.
- **Existing tests:** `wdintel-web/src/ts/react/routes/admin-goi-integrations-neo/__tests__/index.spec.tsx`.
- **Original Echo issue/PR:** https://github.com/echoua/echo/pull/3268.

## Report task polling lifecycle

- **Status:** inferred characterization
- **Behavior ID:** `admin-report-task-polling-lifecycle`
- **Affected route/component:** administrative report-details page and polling hook
- **User role or permission:** administrators allowed to view report history
- **Preconditions:** a report row references a background task that is still running
- **User action or external event:** the task emits incremental log lines and then reaches a terminal report status
- **Expected observable result:** new log lines append once, task progress updates, and polling stops after the report finishes.
- **Loading/empty/error/success behavior:** transient task-state failures surface through the existing error state; a completed task remains visible without further requests.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** polling retains the background-task ID and incremental log offset.
- **Responsive and keyboard requirements:** none at the polling boundary.
- **Known race/idempotency constraints:** completed tasks must not schedule another poll or replay their existing log lines.
- **Source implementation:** `src/ts/react/routes/admin-report-details/use-admin-report-details.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/admin-report-details/__tests__/use-admin-report-details.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as a polling safeguard.

## Report-history download refresh

- **Status:** inferred characterization
- **Behavior ID:** `settings-report-history-download-refresh`
- **Affected route/component:** Settings report-history table
- **User role or permission:** users permitted to download their completed reports
- **Preconditions:** a completed report file is available in the paginated history
- **User action or external event:** the user downloads the report file
- **Expected observable result:** the history reloads so its file/status metadata remains current after the download.
- **Loading/empty/error/success behavior:** download errors use the existing error path and do not claim a successful refresh.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** download and subsequent history requests preserve their existing route and pagination contract.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** a completed download must not leave a stale batch-history row visible.
- **Source implementation:** `routes/settings-neo/SettingsMyReportsSection.tsx`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.

## Transcription results pagination

- **Status:** operational compatibility
- **Behavior ID:** `admin-transcription-results-pagination`
- **Affected route/component:** transcription settings result tab
- **User role or permission:** administrators permitted to inspect transcription results
- **Preconditions:** the result tab loads a paginated transcription response
- **User action or external event:** the user opens results, navigates next/last page, or a load fails
- **Expected observable result:** result rows retain processing-instance metadata; the server cursor and total drive page navigation; unrelated instance-table filters are excluded; failures surface visibly.
- **Loading/empty/error/success behavior:** an API failure emits the existing error notification instead of leaving a stale/empty table without explanation.
- **URL, localStorage, or user-settings persistence:** instance-table state does not leak into the results query.
- **API endpoint and compatibility requirements:** preserves `rows`, `total`, `next_cursor`, `previous_cursor`, and instance metadata response fields.
- **Responsive and keyboard requirements:** existing table pagination controls remain accessible.
- **Known race/idempotency constraints:** each page request uses the cursor returned for the current result set.
- **Source implementation:** `src/ts/react/routes/admin-transcription-settings/TranscriptionResultsTab.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/admin-transcription-settings/__tests__/index.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as operational compatibility and query-safety coverage.

## AI settlement evaluation result ownership

- **Status:** inferred characterization
- **Behavior ID:** `admin-ai-settlement-evaluation-result-ownership`
- **Affected route/component:** AI settlement prompt, result, and worker settings page.
- **User action or external event:** an evaluation finishes after its prompt changes or a source message is deleted; the user saves a prompt, results, or worker configuration.
- **Expected observable result:** only results matching the current prompt and messages can be saved; resetting the prompt or saving worker settings cannot restore stale local state.
- **Known race/idempotency constraints:** an obsolete evaluation completion is discarded before it can update the saved payload.
- **Source implementation:** `routes/admin-ai-settlements/index.tsx`.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/admin-ai-settlements/__tests__/index.spec.tsx`.
- **Original Echo issue/PR, if known:** none recorded; retained as persistence safeguards.

## Administration workspace interaction integrity

- **Status:** inferred characterization
- **Behavior ID:** `admin-workspace-interaction-integrity`
- **Affected route/component:** React administration drawers, tables, settings panels, action menus, and secondary RER maintenance views.
- **User action or external event:** an administrator changes a form, table selection, tab, pagination state, action menu, or asynchronous maintenance workflow.
- **Expected observable result:** actions remain bound to the selected entity and role; drawers, confirmation flows, retries, loading/empty states, and table actions remain reachable and do not apply stale state.
- **Known race/idempotency constraints:** late loads or repeated actions cannot overwrite the current selected entity or duplicate a mutation.
- **Source implementation:** `routes/admin-*/` and related RER maintenance routes.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded; retained as operational safeguards.
