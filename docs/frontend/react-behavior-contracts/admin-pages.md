# Admin page contracts

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
- **Existing test(s):** `wdintel-web/src/ts/react/routes/settings-neo/__tests__/SettingsMyReportsSection.spec.tsx`
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
