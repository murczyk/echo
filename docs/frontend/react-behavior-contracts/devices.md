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
- **Expected observable result:** canonical device fields and arbitrary custom fields are retained; create and update requests preserve arbitrary custom-field keys, omitted patch fields remain omitted, and explicit null values remain intentional clears; keyset cursors, Windows paths, sync outcome details, dynamic tag pages, and analysis-run history normalize without losing wire compatibility.
- **Loading/empty/error/success behavior:** roots, subtree counts, and paginated pages remain separate; empty optional response collections are usable by their consumers.
- **URL, localStorage, or user-settings persistence:** cursors belong to the route state, not the shared API mapper.
- **API endpoint and compatibility requirements:** create/update request bodies preserve canonical field casing and omit only undefined values; search and pagination request compatibility remains part of this contract even without isolated request-shape tests; legacy snake-case response fields normalize for React.
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

## Device file preview format precedence

- **Behavior ID:** `device-file-preview-format-precedence`
- **Affected route/component:** Devices Files and shared document/image/media/map previews.
- **Preconditions:** an accessible content-backed revision is selected. Classification identifies an eligible viewer; successful decoding still depends on actual bytes, parser limits, browser codecs and converter availability.
- **Expected observable result:** trim the filename and normalize the last suffix case-insensitively; use stored extension metadata only when the filename has no suffix. Never infer a format from the original download URL. Converted-map admission uses the same immutable revision filename and metadata fallback as the UI.
- **MIME and container compatibility:** native KML/KMZ and their known MIME types retain map rendering; GPX/GeoJSON/LDK/TRK/ARE/RTE/WPT/SET/FIT select optional preparation. Explicit audio/video/image MIME determines the corresponding media category before audio/video extension fallbacks. Generic or absent MIME permits recognized image suffixes; an unrelated explicit MIME does not imply an image. DOCX/XLSX/KMZ keep specialized rendering with ZIP MIME; a PDF filename with ZIP MIME selects the archive viewer. Document formats use the existing reference document precedence.
- **Loading/empty/error/success behavior:** missing content never starts a viewer. Unsupported, corrupt, oversized and unavailable-codec/converter results remain distinct from successful preview; an accessible original retains its exact filename and bytes.
- **Known race/idempotency constraints:** recognition and preparation concern the selected device/file/revision; conflicting metadata cannot silently substitute a different revision or mutate the stored source snapshot.
- **Source implementation:** `wdintel-web/src/ts/react/routes/shared/message-card/attachment-preview/file-preview-source.ts`, `wdintel-web/src/ts/react/routes/shared/message-card/file-preview-kind.ts`, `wdintel-web/src/ts/react/routes/shared/message-card/document-file-kind.ts`, `wdintel-rs/src/devices/files/preview/bl.rs`, `wdintel-rs/src/devices/files/preview/query.rs`.
- **Default-suite classifier coverage:** No direct default-suite test; behavior is preserved by this contract.
- **Operational coverage:** `wdintel-web/tests/e2e/device-file-preview-interactions.spec.ts`, `wdintel-web/tests/e2e/device-file-preview-images.spec.ts`, `wdintel-web/tests/e2e/device-file-preview-documents.spec.ts`, `wdintel-web/tests/e2e/device-file-preview-media.spec.ts`, `wdintel-rs/src/devices/files/preview/tests.rs`. These consume actual file bytes or exercise database/API admission rather than count classifier outputs as format support.

## Retired manual Device Files synchronization

- **Status:** retired historical behavior
- **Behavior ID:** `device-files-manual-sync-retired`
- **Affected route/component:** the removed `DeviceFileSyncDialog`, `useDeviceFilesSync`, sync helpers, and sync API flow.
- **Expected observable result:** no manual React synchronization dialog, row-freezing/retry flow, or synchronization authorization action remains in the current Device Files client.
- **Current behavior:** Device Files provides the file workspace, tree, search, journal, and analytics functionality. The removed synchronization-specific invariants are historical and no longer client behavior.
- **Source implementation:** current `routes/device-files/` workspace only; the manual synchronization components and hooks were removed upstream.

## Device form mutation safeguards

- **Status:** inferred characterization
- **Behavior ID:** `device-form-mutation-safeguards`
- **Affected route/component:** device create and update form request helpers
- **Expected observable result:** create requests include the source fields used by the create workflow; the analytical name is included only with analytical-data permission. Update requests gate `externalUrl` and `customFields` behind source-data permission, and gate `name`, `aorIds`, and `unitId` behind analytical-data permission. `Cyber` and `Admin` have read, create, source-data, and analytical-data permissions. `CyberViewer` retains read, create, source-data, and file-sync access, but cannot change analytical fields (`name`, `aorIds`, `unitId`); it can listen to audio without uploading audio or editing its text/status. Cyber users can edit the name, unit, and AORs from both the device list and device details, within existing organization visibility and active-device restrictions. Blank external URLs become explicit `null` clears; removed custom-field keys become `null`, while changed and new keys retain their values. Unchanged and unauthorized fields are omitted. Recognized backend snake-case field errors map to editable fields; malformed and unknown errors remain generic.
- **Source implementation:** `wdintel-web/src/ts/react/routes/devices/device-form.ts`, `wdintel-web/src/ts/react/routes/devices/use-devices-page.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/devices/__tests__/device-form.spec.ts`, `wdintel-web/tests/e2e/device-details.spec.ts`

## Device form presentation and local validation

- **Status:** inferred characterization
- **Behavior ID:** `device-form-defaults-and-validation`
- **Affected route/component:** device create and update form presentation
- **Expected observable result:** new forms start with an empty name, AOR list, external URL, and custom fields, with no selected unit; a nullable existing device name appears as an empty editable value. Only field groups available to the current permission set are validated. Analytical validation requires a trimmed, non-empty name with a 255-character maximum when creating a device or changing its name. Editing an existing unnamed device may leave the name empty while updating other fields; the unchanged name is omitted from the update. Source validation accepts an empty external URL or an absolute HTTP/HTTPS URL, with the existing 4096-character maximum. Custom fields are limited to 50 rows; trimmed keys must be non-empty, unique, and at most 128 characters; values are limited to 4096 characters. Request construction trims names, external URLs, and custom-field keys while preserving custom-field values. An unchanged edit produces no mutation payload beyond device identity and is not submitted as an update.
- **Source implementation:** `wdintel-web/src/ts/react/routes/devices/device-form.ts`, `wdintel-web/src/ts/react/routes/devices/use-devices-page.ts`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.

## Device Files search request behavior

- **Status:** inferred characterization
- **Behavior ID:** `device-files-search-request-behavior`
- **Expected observable result:** browse and search requests preserve scope/cursor and literal query semantics, normalize filter lists, and reject invalid local query/date input before submission.
- **Source implementation:** `wdintel-web/src/ts/react/routes/device-files/helpers.ts`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.

## Device file tree content filter

- **Behavior ID:** `device-file-tree-content-filter`
- **Expected observable result:** the Files tree offers “Усі файли”, “З контентом”, and “Без контенту”. Folders remain when a descendant file matches; content and tag filters must match the same file. Root drives remain available for navigation. Folder counters show the total number of files, independent of this filter.
- **Scope:** applies to the tree, including subsequent pages and refreshes; the separate search and journal retain their own filters. Session views use content belonging to the selected session's revision; the current tree uses the current revision.
- **Loading and concurrency:** changing the filter clears branch pages and cursors, cancels pending requests, and reloads the roots. Late responses and file-link expansion must not inject files excluded by the current filter.
- **Persistence and accessibility:** defaults to all files and remains in memory while viewing the device. On desktop and mobile, the tree header's “Фільтри файлів” button opens a menu with mutually exclusive, checked options. Selecting an option closes the menu; an active content filter highlights the button and is included in its accessible label. The button is hidden in search mode.
- **Existing tests:** `wdintel-web/src/ts/react/routes/device-files/__tests__/use-device-file-tree.spec.tsx`, `wdintel-web/tests/e2e/device-details.spec.ts`, `wdintel-rs/src/devices/files/sync/tests/session_reads.rs`.

## Device list local query behavior

- **Status:** inferred characterization
- **Behavior ID:** `devices-list-local-query-behavior`
- **Expected observable result:** device list defaults, lifecycle/unit filters, sorting, sidebar selection, summaries, and local active-filter state follow the route helper implementation.
- **Source implementation:** `wdintel-web/src/ts/react/routes/devices/helpers.ts`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
