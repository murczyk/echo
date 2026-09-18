# Networks

## Networks list and create defaults

- **Behavior ID:** `react-networks-list-defaults`
- **Status:** normative
- **Affected route/component:** Networks Neo list/create drawer
- **User role or permission:** network viewer
- **Preconditions:** page initializes
- **User action or external event:** open drawer/load rows
- **Expected observable result:** sidebar starts collapsed; blank posts are excluded; backend order is preserved; defaults are `id: null`, name `управління`, empty location/radio station, purpose `для управління підлеглим особовим складом`, mode `дуплекс`, type `ведення службового радіообміну`, period `цілодобово`, `doNotArchive: false`, active status, empty unit mask/AOR/unit/post/key IDs/frequency/date fields, `DMR` modulation, and no encryption
- **Loading/empty/error/success behavior:** normal drawer/list states
- **URL, localStorage, or user-settings persistence:** table state
- **API endpoint and compatibility requirements:** `listNetworks`
- **Responsive and keyboard requirements:** drawer reachable
- **Known race/idempotency constraints:** none
- **Source implementation:** `wdintel-web/src/ts/react/routes/rer-networks-neo/use-rer-networks-neo-page.ts`, `wdintel-web/src/ts/react/routes/rer-networks-neo/use-rer-networks-neo-page.mutations.ts`, `wdintel-web/src/ts/react/routes/rer-network-details-neo/use-rer-network-details-neo-page.forms.ts`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded

## Network creation behavior

- **Behavior ID:** `react-networks-create`
- **Status:** normative
- **Affected route/component:** Networks Neo create drawer
- **User role or permission:** authorized editor
- **Preconditions:** create form is open
- **User action or external event:** submit valid/invalid frequency
- **Expected observable result:** valid creation closes drawer and navigates to `/rer-networks-neo/{createdId}`; frequency omission is allowed only for non-RER support; invalid first frequency blocks submission and exposes error
- **Loading/empty/error/success behavior:** validation remains visible
- **URL, localStorage, or user-settings persistence:** new route uses created ID
- **API endpoint and compatibility requirements:** `services/api/networks.createNetwork`
- **Responsive and keyboard requirements:** validation reachable
- **Known race/idempotency constraints:** none
- **Source implementation:** `use-rer-networks-neo-page.mutations.ts`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded

## Deleted-network restoration

- **Behavior ID:** `react-networks-restore`
- **Status:** normative
- **Affected route/component:** edit mutation
- **User role or permission:** authorized editor
- **Preconditions:** edited network is deleted or not
- **User action or external event:** save edit
- **Expected observable result:** deleted network sends `restoreNetwork: true`, non-deleted sends `restoreNetwork: null`, independent of active window/status
- **Loading/empty/error/success behavior:** mutation status applies
- **URL, localStorage, or user-settings persistence:** saved network state
- **API endpoint and compatibility requirements:** `getRestoreNetworkOnEditValue` and `updateNetwork`
- **Responsive and keyboard requirements:** none
- **Known race/idempotency constraints:** none
- **Source implementation:** `rer-network-details-neo/network-status.ts`, `use-rer-networks-neo-page.mutations.ts`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded

## Networks filter, report, and activity presentation

- **Behavior ID:** `react-networks-filter-report-activity`
- **Status:** normative
- **Affected route/component:** filters/reports/activity cells
- **User role or permission:** viewer/report user
- **Preconditions:** filter/report/activity data exists
- **User action or external event:** change status/search/size, run/cancel report, load activity
- **Expected observable result:** backend counts/chips map filters; status reloads immediately, search debounces, sizing does not reload, current settings/IDs form report input, cancelled result stays cancelled, activity has upper bound/maps bars, and recent label expires at 15 minutes
- **Loading/empty/error/success behavior:** activity states remain distinct
- **URL, localStorage, or user-settings persistence:** table filters/sizing
- **API endpoint and compatibility requirements:** `listNetworks`, `getNetworksGroupsActivitySummary`, `launchNetworksEtalonkaReportTask`, `launchNetworkEtalonkaBatchReportTask`, `launchNetworkGoiReportTask`, and `downloadNetworkEtalonkaReportTaskResult`
- **Responsive and keyboard requirements:** controls reachable
- **Known race/idempotency constraints:** none
- **Source implementation:** `use-rer-networks-neo-page.load.ts`, `use-rer-networks-neo-page.reports.ts`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded

## Retained Networks safeguards

- **Behavior ID:** `react-networks-retained-safeguards`
- **Status:** normative
- **Affected route/component:** Networks Neo loader/mutations
- **User role or permission:** viewer/editor
- **Preconditions:** relation refresh, filter changes, reports, or activity requests race
- **User action or external event:** edit/filter/retry/page activity
- **Expected observable result:** stale relations, filtered-out rows, bootstrap filters, unauthorized loads, cancellation races, retries, pagination/replaced-query activity, errors, permissions, and soft-delete removal remain safe
- **Loading/empty/error/success behavior:** activity errors remain distinct
- **URL, localStorage, or user-settings persistence:** none
- **API endpoint and compatibility requirements:** `listNetworks`, `getNetworksGroupsActivitySummary`
- **Responsive and keyboard requirements:** none
- **Known race/idempotency constraints:** query generation and abort boundaries apply
- **Source implementation:** `use-rer-networks-neo-page.load.ts`, `use-rer-networks-neo-page.mutations.ts`
- **Existing tests:** `wdintel-web/src/ts/react/routes/rer-networks-neo/__tests__/use-rer-networks-neo-page.spec.tsx`
- **Original Echo issue/PR, if known:** [#3329](https://github.com/echoua/echo/issues/3329), [#3489](https://github.com/echoua/echo/pull/3489)
