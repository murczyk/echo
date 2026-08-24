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
- **Existing test(s):** `admin-api-integrations/index.spec.tsx`
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
- **Existing tests:** `index.spec.tsx` dirty dismissal, worker baseline, in-flight check, and overflow-delete safeguards.
- **Original Echo issue/PR:** https://github.com/echoua/echo/pull/3268.
