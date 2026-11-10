# Device contracts

## Device page URL filters

- **Original Echo issue:** #3928.
- **Expected observable result:** `sync_id` scopes file browsing and session controls only on `/devices/:id/files`. Overview, Journal, and Audio ignore it, including malformed or unavailable session IDs, and navigation to those pages drops it. Browser Back and Forward restore tag filters from the URL, keeping controls and API requests consistent on the same page.
- Changing the selected session clears file/directory selection and all search parameters, including the pinned archive revision. Selecting the same session keeps the search intact; Back/Forward restores each session's own URL context. Regressions: `wdintel-web/src/ts/react/routes/device-details/__tests__/url-state.spec.ts`, `wdintel-web/tests/e2e/device-details.spec.ts`.
- **Existing tests:** `wdintel-web/tests/e2e/device-details.spec.ts`.

## Device list optional columns and sorting

- **Status:** issue-backed regression
- **Behavior ID:** `devices-list-optional-columns`
- **Affected route/component:** `/devices` list (`DevicesTable`, `DeviceMobileList`)
- **User role or permission:** users permitted to read devices
- **Preconditions:** visible devices have descriptions or custom fields
- **User action or external event:** the user toggles columns, reorders them, changes sorting, or reloads the page
- **Expected observable result:** «Опис» and one column per custom field key (from `/api/device/filter-options` `custom_field_keys`) are hidden by default; new custom field columns appear after «Назва», a user's dragged positions survive reloads, and columns of vanished keys are dropped. Enabled columns also appear under «Деталі» on mobile. Text search matches name, ID, description, and custom field values (not keys).
- **Loading/empty/error/success behavior:** empty values render as `—`; custom field columns appear once filter options load.
- **URL, localStorage, or user-settings persistence:** visibility and order use the `devices` table local-storage keys; the last non-default sorting (e.g. «Створено ↓») is remembered, default remains «Активність ↓».
- **API endpoint and compatibility requirements:** `/api/device/list` items carry `description` and `custom_fields`; custom field keys keep their original casing on the client.
- **Responsive and keyboard requirements:** columns are toggled through the shared MRT column menu.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `src/ts/react/routes/devices/`, `src/ts/react/services/api/devices.ts`, `wdintel-rs/src/devices/devices/query.rs`
- **Existing test(s):** `wdintel-web/src/ts/react/components/mui-customized/table/__tests__/table-state-provider-persistence.spec.tsx`, `wdintel-web/src/ts/react/services/api/__tests__/devices.spec.ts`, `wdintel-rs/src/devices/devices/tests.rs`, `wdintel-rs/src/devices/tests.rs`
- **Original Echo issue/PR, if known:** #3999.

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

## Device typography

- **Original Echo issue:** #3930.
- All device pages, forms, dialogs, sidebars and charts inherit the shared Echo/MUI font family. Reuse typography from corresponding components outside Devices; do not add device-specific font assets, families, or size scales.
- Page titles match `PageHeader` (`h5`, weight 600, line height 1.2) on desktop and mobile. Mobile sheets and overview cards use the `h6` title used by unit and GOI integration drawers. Overview metadata uses standard `body2` labels and values, with `subtitle2` subsection titles.
- Activity chart axes and tooltip titles match `NetworkDetailsActivityChart`. Status toggles use standard MUI button typography. Secondary session labels and mobile journal paths use the common caption style; paths inherit the UI font family.
- File names and table text use the shared 14px body style; secondary metadata uses the existing 12px caption style. Table headers use 14px bold text, matching the shared Material React Table headers used by Units.
- Search uses the standard 16px input style. Compact filter fields use 14px text, filter chips retain the existing 13px compact style, and the search scope menu retains its 12px secondary style.
- Reuse the common device sidebar, Power/MUI controls, Echo chips, and attachment preview components. Document detail headings and state messages use standard MUI typography variants. Preserve document content formatting in shared viewers.
- No direct default-suite test; behavior is preserved by this contract.

## Device overview layout

- The overview navigation is 176px wide on desktop. Files and Audio retain their own sidebar widths.
- Metadata and upload statistics are always visible, without collapse controls. File and audio counters belong to the statistics card; active analytical tags with files share one card of names and counts, without file-list requests or navigation actions.
- Metadata fills the top row. Statistics and tags appear side by side on wide screens and stack on smaller screens. Empty custom fields are omitted from the overview. Detailed day charts fill the available width for short histories and retain horizontal scrolling to the latest day for long histories.
- Existing tests: `wdintel-web/tests/e2e/device-details.spec.ts`.

## Device-file search mode

- **Original Echo issue:** #3930.
- Search results use a dedicated table with name, path, and folder actions. The single folder action opens the containing folder and ends the search session. Clicking a found folder name keeps the session. The clear button in the search field also ends the session.
- Opening files, browsing found folders, preview navigation, and browser Back/Forward preserve the search. Closing a result preview returns to results; closing a file opened inside a found folder returns to that folder. A breadcrumb links back to the results. Results show only the path root and search label. Browsing a found folder shows its name immediately after the search label, followed by any folders opened inside it; its earlier ancestors are omitted. Search text, scope, global mode, and the found folder anchoring this relative path are restored from the URL on reload.
- Searches cover the current folder's subtree by default. The input's dropdown opens on focus and offers one action for device-wide search. Enter in the input always searches the current folder's subtree, including after a global search. Ranking prefers exact names, then prefixes, then substring matches; ties prefer nearby paths, then UTF-8 name and ID. Pagination retains the same order and rejects cursors from another search scope.
- Folders matching the name remain in results when their subtree contains a file matching the active filters, including the default content filter; empty filtered folders remain hidden.
- API search flags are optional; requests without them retain the existing search ordering and scope. Session searches retain the selected revisions. A scoped archive search carries `archive_revision` through reloads and pagination and reads the same immutable archive snapshot as browsing. Its cursor is bound to that revision and archive job; device-wide search omits the archive revision.
- When `filters` is supplied, legacy top-level `tag_ids`, `tag_match`, and `untagged` do not prefilter search candidates, for either current or session reads. Descendant matches can therefore retain an untagged folder.

## Device-file request loading

- **Original Echo issue:** #3930.
- Files do not load the Audio list. Returning to Audio preserves its existing selection and editor state.
- The shared Navbar consumes the system settings loaded by Shared; it fetches them only after an explicit settings-saved event. Shared defers its unit/network lookups and their periodic reconciliation on Files, and initializes them when navigating to another route.
- Filter extensions and tags load on first opening the filters and remain loaded while the device/session scope is retained. Tags referenced by the URL load immediately so invalid tag IDs can still be removed.
- The ordinary file tree fetches branches only while its sidebar or mobile sheet is visible, and waits for roots matching the active filters. Existing branch requests are shared while pending. Tree-only requests omit breadcrumbs.
- The main folder listing pauses during search results and file preview, retaining loaded pages and scroll positions. Compatible tree/folder requests share page-scoped responses using device, session, revision, filters, sorting, and cursor identity. A consumer's cancellation does not abort another consumer's request. Scope changes, explicit refreshes, and access failures invalidate the appropriate cache; late aborted responses cannot repopulate it.
- Direct file links resolve the requested revision independently of empty, loading, or filtered tree roots. An authorized `locate` response opens the preview immediately; optional tree expansion never gates selection. Locate errors and session-membership checks remain visible, and stale responses cannot select another link's file. Regressions: `wdintel-web/src/ts/react/routes/device-files/__tests__/use-linked-device-file.spec.tsx`, `wdintel-web/tests/e2e/device-file-explorer.spec.ts`.
- Scoped browse cursor identity ignores breadcrumb inclusion and normalizes omitted sorting to name ascending. Active filters, folder, session, revision, and nondefault sorting still bind session, archive, and sorted cursors. The default current listing retains its legacy cursor format. Ignored legacy filter fields do not change scoped identity when `filters` is supplied.
- Closing the sidebar clears loading flags and retains interrupted branch operations with their entries and cursors. Reopening resumes required expanded branches, including pagination and refresh; collapsed branches resume on expansion. Changing the data scope discards interrupted work. Regressions: `wdintel-web/src/ts/react/routes/device-files/__tests__/use-device-file-tree.spec.tsx`, `wdintel-web/tests/e2e/device-file-explorer.spec.ts`.
- Subtree counts are requested only for ordinary folders in the main grid, never for hidden tree branches, search results, or the table. Already loaded counts survive grid/list switching.
- Session summary requests reuse completed and pending IDs within the same refresh generation. Periodic session polling updates the sidebar without refreshing unchanged file listings; metadata/content/tag changes in the relevant session scope refresh the file data while preserving an open preview. Explicit refresh remains available.
- Regression coverage: `wdintel-web/tests/e2e/device-file-explorer.spec.ts`, `wdintel-web/src/ts/react/routes/device-files/__tests__/use-device-directory.spec.tsx`, `wdintel-web/src/ts/react/routes/device-details/__tests__/index.spec.tsx`, and `wdintel-web/src/ts/react/components/app-navbar/__tests__/AppNavbar.cyber-visibility.regression.spec.tsx`.
- **Existing tests:** `wdintel-web/tests/e2e/device-file-explorer.spec.ts`, `wdintel-web/src/ts/react/routes/device-files/__tests__/use-device-files.load.spec.tsx`, `wdintel-rs/src/devices/files/tests.rs`, `wdintel-rs/src/devices/files/sync/tests/nonempty_filters.rs`.

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
- **Expected observable result:** Files defaults to content-bearing files; checking “Показувати файли без контенту” also includes missing content. Folders and root drives remain only when a descendant file matches, including when the folder itself is a favorite. Empty nested folders do not keep ancestors visible. Archives remain when the source file matches or provides navigation to matching member files. Selecting only the folder type lists nonempty folders, with the remaining filters applied to their descendant files. All selected predicates must match the same file. Folder cards show the total number of files, independent of this filter; tree rows have no file-count badges.
- **Scope:** applies to the tree, directory grid/list, and search, including subsequent pages and refreshes. The journal has no tag filter controls or tag-option requests and ignores tag-filter URL parameters, including on subsequent pages. Tags remain visible in its rows. Session views use content belonging to the selected session's revision; the current tree uses the current revision.
- **Loading and concurrency:** changing the filter clears branch pages and cursors, cancels pending requests, and reloads the roots. Late responses and file-link expansion must not inject files excluded by the current filter.
- **Persistence and accessibility:** defaults to files with content and remains in memory while viewing the device. On desktop and mobile, the page header's “Фільтри файлів” button expands a filter panel above directory contents. The inclusion checkbox is unchecked by default; the button is blue only while its panel is open, and a red dot indicates changes from default filters. The default content filter does not show a dot. Search results use the same content filter.
- **Existing tests:** `wdintel-web/src/ts/react/routes/device-files/__tests__/use-device-file-tree.spec.tsx`, `wdintel-web/tests/e2e/device-details.spec.ts`, `wdintel-rs/src/devices/files/sync/tests/session_reads.rs`.

## Device file explorer

- **Behavior ID:** `device-file-explorer-3930`
- **Default content filter:** initial Files state is “З контентом” (`has_content: true`) for tree, directory, and search requests. Matching ancestor folders and root drives remain navigable. Checking “Показувати файли без контенту” includes files without content as well.
- **Immediate filters:** favorites, unviewed status, archive failures/password protection, content availability, file types, extensions, tags, and modification dates apply to roots, tree branches, folders, archive members, and search. Changing any filter cancels stale requests and resets their cursors; no Apply button is required. Search by name remains in the toolbar.
- **File types and extensions:** file types are semantic categories and allow multiple selections; extensions come from the authorized device/session catalog and allow multiple selections. Choices within a field use OR; separate fields use AND. MIME is not exposed in the filter card. Type, extension, and tag chips use compact typography. Modification dates remain visible, and an invalid range is shown before requests are changed.
- **ZIP document metadata:** DOCX with a ZIP MIME remains a document in current and session filters, search, and ancestor visibility, consistent with its preview and icon. Ordinary ZIP files remain archives.
- **Path root:** folder and file breadcrumbs start with a device-icon link labeled “До початку шляху”, including fullscreen. It opens the drive list, clearing the selected file, directory, and archive revision while preserving other URL context. At roots the icon marks the current location.
- **Scroll edge:** the native grid/table scroll viewport extends through the right gutter to the page edge, or to the sessions-panel boundary when that panel is open. The content, toolbar, filter panel, and file-preview header retain their aligned edges. Mobile retains native touch scrolling and has no horizontal page overflow.
- **Return from preview:** opening a file temporarily hides the mounted folder view. Closing the preview or using browser Back retains loaded pages and the grid's vertical scroll or the table's vertical and horizontal scroll, including after navigating between sibling files. The hidden folder controls are unavailable until returning to the folder.
- **Sidebar and filters:** the Files sidebar header has no manual refresh button. The folder path, filter panel, grid, and table share aligned content edges without an extra horizontal inset. On desktop with the right panel closed, the right edge also aligns with the page header's right-panel toggle; the filter panel retains its internal padding and mobile scrolling limit.
- **Tree overflow:** file and folder names stay on one line at their full width, including archive entries and deeply nested folders. The tree viewport scrolls horizontally when expanded rows exceed the sidebar width, independently of the main panel and without horizontal page overflow; the mobile tree drawer uses the same behavior.
- **Tree density:** desktop rows are 32px tall and mobile rows are 40px tall, with 4px padding and icon gaps, an 8px indentation step, and no gaps between rows. Chevron buttons expand or collapse branches independently of folder-name navigation; ancestor guides follow the same indentation.
- **Folder icons:** directories use filled folder icons, with an open-folder variant for expanded tree branches. Directory and folder-style archive icons share the gold `folderIcon` color (`#d5a052`) in the tree, cards, and table, in both light and dark modes.
- **Password-protected archives:** an archive with the server reason `password_protected` uses a gold lock icon with the accessible title “Архів захищений паролем” in the tree, grid, table, and search results. The tree also updates the icon when archive preparation discovers protection. Other archive failures and ordinary files retain their existing icons. The indicator keeps the original icon dimensions and does not change row or card heights.
- **Expected observable result:** clicking a folder opens its grid/list and updates the URL; the tree expander only expands/collapses its branch. The page header contains the sidebar toggle and device/section breadcrumbs. The clickable folder path appears above the folder contents without a card background or border, with search, filters, and grid/list controls aligned to its right on the same row, including mobile. Toolbar buttons and icons match the small file-preview actions; the compact search field and row spacing keep the path row no taller than the preview header. These controls also remain available at roots. Opening a file shows its path in the preview header beside Info, including fullscreen. Root loading and failures remain visible when the tree is collapsed. Root drives remain navigable under filters.
- **Path overflow:** folder, file, and fullscreen paths stay on one line. When the path does not fit, the earliest folders move into an ellipsis menu, preserving the device icon and as many trailing segments as fit. Resizing recomputes the hidden prefix and restores segments when space allows. Menu items remain real links, retain archive revisions and other URL context, and support keyboard selection, Escape, and focus return. Only a current folder or filename that cannot fit by itself is shortened, with the full name and path available on hover.
- **List view:** “Список” shows a table with “Назва”, “Перегляд”, “Обране”, “Дата завантаження”, “Дата створення”, “Дата зміни”, “Розмір”, “Тип”, and “Теги” columns. “Тип” shows categories shared with attachment icons: “Зображення”, “Документи”, “Таблиці”, “Презентації”, “Аудіо”, “Відео”, “Архіви”, “Карти”, “Код і дані”, or “Інше”, with “Папка” for directories. Filename, extension, MIME normalization, and archive recognition follow the same rules as the file icons. Upload time is the selected revision's content publication timestamp, not registry discovery time; creation/modification times come from source metadata. Names open entries; a separate star changes favorites without opening them. Missing dates and unknown sizes use “—”, zero-byte files show “0 Б”, and folders have no viewed marker. Folder sizes sum available source content bytes in the complete subtree, with zero for empty or metadata-only subtrees. Native folders count archive files once, without adding their extracted members. Archive folders and historical sessions use the selected revisions for both size display and sorting. The table owns both scroll axes without overflowing the page; column headers stay visible and horizontal scrolling remains accessible in long directories. Switching between table and grid preserves directory, filters, and markers. The chosen view is stored in browser local storage and survives reloads across device and archive pages; invalid or unavailable storage falls back to the grid while in-memory switches keep working.
- **Column widths:** every list header has a focusable vertical resize handle. Pointer dragging changes only that column, stays active outside the handle through pointer capture, and stops on release/cancellation without sorting. Arrow keys change width by 10 CSS pixels, Home/End select bounded minimum/maximum widths, and double-click restores the default column width. Values are stored in browser local storage as rem widths and survive grid/list switches and reloads; unavailable storage keeps in-memory resizing functional. Narrow headers and cells truncate without overlapping adjacent columns, while full names and dates remain available on hover. The table owns horizontal overflow. Browser regressions: `wdintel-web/tests/e2e/device-file-explorer.spec.ts`.
- **Sorting:** a sort button follows the filter button. Its menu selects name, size, content upload time, source creation time, or source modification time; selecting the same field again reverses the direction. The matching table headers use the same sorting state and handler, show the active direction, and expose `aria-sort`; header buttons support mouse and keyboard activation. The other table headers remain static. Initial order is ascending by name. Files and folders share the selected order without kind priority; missing values sort last in either direction, and equal values use name and entry ID as stable tie-breakers. Directory, archive, session, and search ordering happens on the server before pagination. Changing the field or direction cancels earlier requests and restarts pagination, while changing grid/list mode retains the selection. Sorting does not reorder the navigation tree. Roots support name order and otherwise retain their server order. The sort button is blue only while its menu is open; a red dot marks any order other than name ascending.
- **Files:** cards show source creation/modification dates. Folder cards show their subtree size alongside the file count; file cards omit size. Tags use the same neutral outlined badges as the device list, on one line in their table column; they are omitted from cards and tree rows. Up to three complete badges fit beside a +N count of hidden tags. Narrowing the column reduces the visible prefix; a single long badge truncates with an ellipsis. Hovering or focusing the summary reveals every full name in a tooltip, and Escape dismisses it. Row heights remain unchanged when the column resizes. Missing content dims a file without removing its open action. “Нове” and a check mark describe the current user's viewed state independently of content availability. Clicking either marker toggles the selected revision between new and viewed without opening the file. Grid, table, search, and archive listings share this behavior. Writes use the existing viewed action and the idempotent unviewed action; both validate device read access and an accessible file revision, including metadata-only ordinary files. Pending writes disable the matching revision control; failed writes preserve the previous marker and surface an error toast. A successful toggle survives a fresh browser session, never changes another user or revision, and is immediately reflected by the unviewed filter. Opening a new file still marks its published revision viewed automatically. File and folder favorites are shared with users who can access the device; the favorite control does not open the entry.
- **Preview and navigation:** opening a file reuses the message attachment viewers and records its revision as viewed for the current user. Previous/next controls navigate loaded sibling files without selecting folders or wrapping at the ends. “До папки” returns to the retained directory. Archive directory rows also open a revision-specific directory URL; their chevrons only expand the tree. Copying a file or directory URL restores that location after authorization; browser back/forward restores navigation.
- **Original archive download:** the path toolbar in a prepared archive or any of its folders exposes “Скачати початковий архів”. The browse response supplies the containing archive's immutable content reference, including for empty folders and direct links. A nested archive downloads its own original. The action uses the existing authorized revision-specific content endpoint and native browser download after a HEAD check, preserving the original filename and bytes. It survives reloads, does not change the open folder, and disappears outside archives. Pending downloads disable repeated activation, failures show a toast, and leaving the archive cancels a pending check. Upload contracts are unchanged.
- **Folder return:** within the mounted Files explorer, the 20 most recently visited directory/revision scopes retain their loaded pages, continuation cursor, and separate grid/table scroll positions. Returning through breadcrumbs, tree navigation, or browser history restores both table axes before automatic pagination resumes. A new folder starts at the top. Changing device, session, enabled state, filters, or sorting clears this history; explicit refresh and 401/403/404 responses also invalidate retained directories. Entries continue to use the current favorite/viewed markers.
- **Search and pagination:** content, favorites, unviewed, archive failures/password protection, and tag filters reach server requests. Filter changes restart search pagination and discard stale responses. Search cards retain full paths to distinguish duplicate filenames. Grid, table, search, and archive contents automatically request the next page within 240px of the bottom of their own scroll viewport, without a load-more button. Empty bounded-scan pages continue automatically; short pages fill the viewport. Only one page request runs at a time. Opening a file pauses automatic requests until returning to the retained folder. Errors stop automatic retries, expose an explicit retry action, and preserve loaded entries; retrying a continuation keeps its cursor. Initial loading and continuation loading have separate indicators. A pending continuation keeps existing entries visible and appends six animated skeleton cards or table rows matching the selected view; table skeleton cells align with the current columns. An accessible loading status remains available without an additional spinner. Placeholders disappear on success or failure and never become entries, favorites, or preview navigation targets.
- **Existing tests:** `wdintel-web/src/ts/react/routes/device-files/components/__tests__/DeviceFileCards.spec.tsx`, `wdintel-web/src/ts/react/routes/device-files/components/__tests__/DeviceArchiveTree.spec.tsx`, `wdintel-web/src/ts/react/routes/device-files/components/__tests__/DeviceFilePreviewNavigation.spec.tsx`, `wdintel-web/src/ts/react/routes/device-files/__tests__/use-device-files.load.spec.tsx`, `wdintel-web/src/ts/react/routes/device-files/__tests__/use-device-directory.spec.tsx`, `wdintel-web/tests/e2e/device-file-explorer.spec.ts`, `wdintel-web/tests/e2e/device-details.spec.ts`.
- **Folder dates:** grid and list use the subtree minimum source creation time and maximum source modification time, ignoring missing dates; empty/unknown dates remain missing. Folder upload time is the first server registration and survives re-sync. Directory date ordering precedes pagination, while session/archive dates follow their selected revisions. Roots expose the same dates. FileSync/upload request contracts are unchanged. Database regressions: `wdintel-rs/src/devices/files/sync/tests/folder_dates.rs` and `wdintel-rs/src/devices/files/archive/publication_tests.rs`.
- **Sorting API regression:** `wdintel-rs/src/devices/files/tests.rs` exercises both directions, ties, zero/unknown sizes, missing timestamps, current/session browsing and searching, one-entry pages, and rejection of a cursor from a different sort direction. Optional `sort_by` and `sort_direction` fields on browse/search requests preserve the default API behavior when omitted.

## Device list local query behavior

- **Status:** inferred characterization
- **Behavior ID:** `devices-list-local-query-behavior`
- **Expected observable result:** device list defaults, lifecycle/unit filters, sorting, sidebar selection, summaries, and local active-filter state follow the route helper implementation.
- **Source implementation:** `wdintel-web/src/ts/react/routes/devices/helpers.ts`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
