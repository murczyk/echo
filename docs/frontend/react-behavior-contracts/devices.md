# Device contracts

## Device-detail response ordering

- **Status:** inferred characterization
- **Behavior ID:** `device-details-stale-response`
- **Affected route/component:** Device Details custom element
- **User role or permission:** users permitted to inspect device details
- **Preconditions:** a device detail request is in flight when the element changes device ID
- **User action or external event:** the earlier request completes after the newer device request
- **Expected observable result:** the page continues to display the newer device and never shows the stale device.
- **Loading/empty/error/success behavior:** late responses are ignored rather than replacing the current detail view.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** a response is committed only for its matching device ID.
- **Responsive and keyboard requirements:** none at the element boundary.
- **Known race/idempotency constraints:** switching device IDs invalidates older detail requests.
- **Source implementation:** `src/ts/react/device-details-page-element.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/__tests__/device-details-page-element.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as a stale-response safeguard.

## Device-file search response ordering

- **Status:** inferred characterization
- **Behavior ID:** `device-files-search-stale-response`
- **Affected route/component:** Device Files search loader
- **User role or permission:** users permitted to browse device files
- **Preconditions:** a file search is in flight and the user changes its root scope
- **User action or external event:** the earlier search response arrives after a newer scoped search completes
- **Expected observable result:** only the latest scope's entries remain visible.
- **Loading/empty/error/success behavior:** the stale response is ignored without replacing the newer result.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** searches retain their requested root entry identity.
- **Responsive and keyboard requirements:** none at the loader boundary.
- **Known race/idempotency constraints:** a response must be associated with its initiating scope before committing state.
- **Source implementation:** `src/ts/react/routes/device-files/use-device-files.load.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/device-files/__tests__/use-device-files.load.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as a stale-response safeguard.

## Device Analytics tag archival

- **Status:** inferred characterization
- **Behavior ID:** `device-analytics-tag-archive-restore`
- **Affected route/component:** Device Analytics tag action menu
- **User role or permission:** users permitted to manage dynamic tags
- **Preconditions:** an existing active or archived tag is visible in the catalog
- **User action or external event:** the user chooses Archive or Restore from that tag's action menu and confirms the operation
- **Expected observable result:** the matching tag ID is archived or restored and the catalog reflects its archived/active state.
- **Loading/empty/error/success behavior:** no unrelated tag is mutated while the operation completes.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** archive and restore requests retain the selected tag ID.
- **Responsive and keyboard requirements:** the existing menu remains accessible.
- **Known race/idempotency constraints:** the action must remain associated with the selected menu row through the confirmation flow.
- **Source implementation:** `src/ts/react/routes/admin-device-analytics/DeviceTagsSettingsPanel.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/admin-device-analytics/__tests__/index.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as a destructive-action safeguard.

## Global file reanalysis confirmation

- **Status:** inferred characterization
- **Behavior ID:** `device-analytics-global-reanalysis-confirmation`
- **Affected route/component:** Device Analytics tag administration
- **User role or permission:** users permitted to schedule global device-file reanalysis
- **Preconditions:** file-dependent Analytics actions are available
- **User action or external event:** the user requests reanalysis of all files
- **Expected observable result:** the page requests confirmation before scheduling the global operation.
- **Loading/empty/error/success behavior:** cancellation leaves the operation unscheduled; confirmation schedules the operation through the existing action boundary.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** no request is made before confirmation.
- **Responsive and keyboard requirements:** the existing confirmation control remains accessible.
- **Known race/idempotency constraints:** a dismissed confirmation must not produce a background reanalysis request.
- **Source implementation:** `src/ts/react/routes/admin-device-analytics/DeviceTagsSettingsPanel.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/admin-device-analytics/__tests__/index.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as a destructive-action safeguard.

## Missing file-registry configuration

- **Status:** inferred characterization

**Behavior ID:** `device-file-registry-unavailable`

- **Affected route/component:** Device Files, file tree, Device Analytics tags, and normal device error formatting.
- **User role or permission:** users authorized to view the affected device data.
- **Preconditions:** a file-registry-dependent request receives the legacy configuration failure.
- **External event:** legacy HTTP 503 whose exact English body identifies missing `[file_registry]` configuration.
- **Expected observable result:** Ukrainian actionable explanation is shown; the raw backend diagnostic is not exposed as the user-facing message; unrelated 503 responses retain their normal error behavior.
- **Loading/empty/error/success behavior:** the Analytics tags page shows a persistent warning, suppresses an empty catalog, and disables file-dependent actions.
- **URL, localStorage, or user-settings persistence:** none.
- **API compatibility:** classification preserves the existing backend response body and does not require a structured error code.
- **Responsive and keyboard requirements:** disabled actions remain visibly and semantically unavailable.
- **Known race/idempotency constraints:** a retry of an unrelated 503 must not be permanently classified as missing configuration.
- **Source implementation:** `wdintel-web/src/ts/react/routes/devices/helpers.ts`, `admin-device-analytics/DeviceTagsSettingsPanel.tsx`.
- **Existing tests:** `wdintel-web/src/ts/react/routes/admin-device-analytics/__tests__/index.spec.tsx`, `wdintel-web/src/ts/react/routes/device-files/__tests__/use-device-file-tree.spec.tsx`
- **Original Echo issue/PR:** https://github.com/echoua/echo/pull/3268.

## Device file and analysis API compatibility

- **Status:** operational compatibility

**Behavior ID:** `device-file-analysis-api-compatibility`

- **Affected route/component:** device detail, file tree, journal, synchronization, dynamic-tag, and analysis-run React consumers.
- **User role or permission:** users authorized for the target device and its files.
- **Preconditions:** a device detail, file page, journal page, synchronization request, or analysis-run page is requested.
- **User action or external event:** browsing/searching files, loading journal entries, synchronizing a path, or reviewing dynamic-tag and run results.
- **Expected observable result:** canonical device fields and arbitrary custom fields are retained; keyset cursors, explicit null clears, Windows paths, sync outcome details, dynamic tag pages, and analysis-run history normalize without losing wire compatibility.
- **Loading/empty/error/success behavior:** roots, subtree counts, and paginated pages remain separate; empty optional response collections are usable by their consumers.
- **URL, localStorage, or user-settings persistence:** cursors belong to the route state, not the shared API mapper.
- **API endpoint and compatibility requirements:** request bodies preserve canonical field casing and omit only undefined values; legacy snake-case response fields normalize for React.
- **Responsive and keyboard requirements:** none at the API boundary.
- **Known race/idempotency constraints:** synchronization must target the exact path identity supplied by the current file view; an in-flight submission freezes its row snapshot, never retries an uncertain transport failure automatically, and rejects mutation after capability revocation.
- **Source implementation:** `wdintel-web/src/ts/react/services/api/devices.ts`.
- **Existing test(s):** `wdintel-web/src/ts/react/services/api/__tests__/devices.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational compatibility coverage.

## Device workspace interaction integrity

- **Status:** inferred characterization
- **Behavior ID:** `device-workspace-interaction-integrity`
- **Affected route/component:** device list, detail, analytics, file tree, journal, and synchronization views.
- **User action or external event:** the user changes a device selection, browses files/journal entries, opens synchronization, or follows a detail/analytics action.
- **Expected observable result:** selection, pagination, tree expansion, synchronization, and result actions remain associated with the intended device/path and retain visible loading, empty, error, and success states.
- **Known race/idempotency constraints:** a refresh or route change cannot apply a prior device/path operation to the current view.
- **Source implementation:** `routes/devices/`, `routes/device-details/`, and `routes/device-files/`.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded; retained as user-visible operational safeguards.

## Retired manual Device Files synchronization

- **Status:** retired historical behavior
- **Behavior ID:** `device-files-manual-sync-retired`
- **Affected route/component:** the removed `DeviceFileSyncDialog`, `useDeviceFilesSync`, sync helpers, and sync API flow.
- **Expected observable result:** no manual React synchronization dialog, row-freezing/retry flow, or synchronization authorization action remains in the current Device Files client.
- **Current behavior:** Device Files provides the file workspace, tree, search, journal, and analytics functionality. The removed synchronization-specific invariants are historical and no longer client behavior.
- **Source implementation:** current `routes/device-files/` workspace only; the manual synchronization components and hooks were removed upstream.
