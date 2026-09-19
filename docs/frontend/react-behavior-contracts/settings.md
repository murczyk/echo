# Settings

## Message-card ordering regression

- **Behavior ID:** `react-settings-message-card-order`
- **Status:** issue-backed regression
- **Affected route/component:** `SettingsMessageCard`
- **User role or permission:** authenticated user
- **Preconditions:** settings render
- **User action or external event:** open settings
- **Expected observable result:** sorting follows the long-message setting
- **Loading/empty/error/success behavior:** normal settings loading
- **URL, localStorage, or user-settings persistence:** user settings
- **API endpoint and compatibility requirements:** `services/api/user-settings.saveUserSettings`
- **Responsive and keyboard requirements:** controls are keyboard reachable
- **Known race/idempotency constraints:** none
- **Source implementation:** `wdintel-web/src/ts/react/routes/settings-neo/SettingsMessageCard.tsx`
- **Existing tests:** `wdintel-web/src/ts/react/routes/settings-neo/__tests__/SettingsMessageCard.spec.tsx`
- **Original Echo issue/PR, if known:** [#3455](https://github.com/echoua/echo/issues/3455)

## Message-card choices and callbacks

- **Behavior ID:** `react-settings-message-card-choices`
- **Status:** normative
- **Affected route/component:** `SettingsMessageCard`
- **User role or permission:** authenticated user
- **Preconditions:** controls render
- **User action or external event:** choose tag layouts `full`, `compact`, `hidden`, preview limits `20`, `40`, `null`, media summary, or collapsed attachments
- **Expected observable result:** active choices are no-ops, callbacks receive application values rather than labels, and attachment/media controls retain placement
- **Loading/empty/error/success behavior:** follows settings loading
- **URL, localStorage, or user-settings persistence:** user settings
- **API endpoint and compatibility requirements:** `saveUserSettings`
- **Responsive and keyboard requirements:** controls are reachable
- **Known race/idempotency constraints:** active choice creates no mutation
- **Source implementation:** `SettingsMessageCard.tsx`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded

## Settings route and feature presentation

- **Behavior ID:** `react-settings-route-presentation`
- **Status:** normative
- **Affected route/component:** `SettingsNeoPage`
- **User role or permission:** authenticated user
- **Preconditions:** route/feature data load
- **User action or external event:** open tabs/My Reports, disable transcription, or fail server-info
- **Expected observable result:** applicable tabs show, My Reports redirects to `/my-reports`, transcription hides, and required settings stay usable
- **Loading/empty/error/success behavior:** optional failure does not block settings
- **URL, localStorage, or user-settings persistence:** route section selects tab
- **API endpoint and compatibility requirements:** `fetchServerInfo`, `currentSystemSettings`
- **Responsive and keyboard requirements:** tabs navigable
- **Known race/idempotency constraints:** none
- **Source implementation:** `wdintel-web/src/ts/react/routes/settings-neo/index.tsx`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded

## Persisted Settings preferences

- **Behavior ID:** `react-settings-persisted-preferences`
- **Status:** normative
- **Affected route/component:** Duty and Analysis sections of `SettingsNeoPage`
- **User role or permission:** authenticated user
- **Preconditions:** user settings are loaded
- **User action or external event:** change the Analysis map placement, inline callsign-form visibility, or Duty/Analysis transcription defaults
- **Expected observable result:** the selected map placement and callsign-form visibility persist, while Duty and Analysis transcription preferences remain independent and do not overwrite one another
- **Loading/empty/error/success behavior:** controls follow the settings loading and save state
- **URL, localStorage, or user-settings persistence:** values persist through user settings
- **API endpoint and compatibility requirements:** `wdintel-web/src/ts/react/services/api/user-settings.ts` `saveUserSettings`
- **Responsive and keyboard requirements:** controls remain keyboard reachable
- **Known race/idempotency constraints:** changing one transcription preference must preserve the other
- **Source implementation:** `wdintel-web/src/ts/react/routes/settings-neo/index.tsx`, `wdintel-web/src/ts/react/hooks/use-duty-settings.ts`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded

## User-settings compatibility defaults

- **Behavior ID:** `react-user-settings-compatibility-defaults`
- **Status:** operational compatibility
- **Affected route/component:** user-settings API boundary
- **Expected observable result:** omitted or unsupported settings normalize to `analysisMapInSidebar: false`, `dutyAudioTranscriptionCollapsed: false`, `analysisAudioTranscriptionCollapsed: false`, `showAnalysisCallsignAddForm: false`, `showClassicDuty: false`, `showClassicAnalysis: false`, `dutyCollapseMediaPreviews: true`, `mediaSummaryEnabled: false`, `messageTextPreviewLines: 20`, and `messageSortBy: interception`.
- **Source implementation:** `wdintel-web/src/ts/react/services/api/user-settings.ts`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.

## System-settings optional feature flags

- **Behavior ID:** `react-system-settings-optional-feature-flags`
- **Status:** operational compatibility
- **Affected route/component:** system-settings API boundary
- **Expected observable result:** missing optional backend feature flags, including audio transcription, Peleng distance-to-battleline, and bot tags, normalize to `false`.
- **Source implementation:** `wdintel-web/src/ts/react/services/api/system-settings.ts`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.

## My Groups presentation

- **Behavior ID:** `react-settings-groups-presentation`
- **Status:** normative
- **Affected route/component:** `SettingsMyGroupsSection`
- **User role or permission:** authenticated user, feature-gated editor
- **Preconditions:** group list is empty or populated
- **User action or external event:** open My Groups
- **Expected observable result:** tab, empty state, table, and feature-flagged editing appear
- **Loading/empty/error/success behavior:** empty and populated states differ
- **URL, localStorage, or user-settings persistence:** none
- **API endpoint and compatibility requirements:** `listMyAdminGroups`
- **Responsive and keyboard requirements:** table actions reachable
- **Known race/idempotency constraints:** none
- **Source implementation:** `SettingsMyGroupsSection.tsx`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded

## My Groups retained safeguards

- **Behavior ID:** `react-settings-groups-save`
- **Status:** normative
- **Affected route/component:** `SettingsMyGroupsSection`
- **User role or permission:** feature-enabled editor
- **Preconditions:** editor is open
- **User action or external event:** save selected organisms or save without administrator
- **Expected observable result:** selected IDs submit and administrator-less save is rejected
- **Loading/empty/error/success behavior:** validation error remains visible
- **URL, localStorage, or user-settings persistence:** update persists membership
- **API endpoint and compatibility requirements:** `updateMyAdminGroup`
- **Responsive and keyboard requirements:** controls reachable
- **Known race/idempotency constraints:** prevents destructive administrator-less update
- **Source implementation:** `SettingsMyGroupsSection.tsx`
- **Existing tests:** `wdintel-web/src/ts/react/routes/settings-neo/__tests__/index.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded

## Hidden organism membership

- **Behavior ID:** `react-settings-hidden-organisms`
- **Status:** normative
- **Affected route/component:** `SettingsMyGroupsSection`
- **User role or permission:** feature-enabled editor
- **Preconditions:** assigned IDs are absent from selector reference data
- **User action or external event:** change visible selections
- **Expected observable result:** hidden IDs survive
- **Loading/empty/error/success behavior:** selector may omit assigned values
- **URL, localStorage, or user-settings persistence:** group membership persists
- **API endpoint and compatibility requirements:** `updateMyAdminGroup`
- **Responsive and keyboard requirements:** none
- **Known race/idempotency constraints:** visible updates cannot erase hidden membership
- **Source implementation:** `SettingsMyGroupsSection.tsx`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded

## Organism-tag presentation

- **Behavior ID:** `react-settings-organism-tags`
- **Status:** normative
- **Affected route/component:** `SettingsMyOrganismSection`
- **User role or permission:** authenticated user
- **Preconditions:** tag request is pending, populated, empty, or fails
- **User action or external event:** open the section
- **Expected observable result:** help, populated, empty, loading, and error states remain distinct
- **Loading/empty/error/success behavior:** each state is presented
- **URL, localStorage, or user-settings persistence:** none
- **API endpoint and compatibility requirements:** `listCurrentOrganismTags`
- **Responsive and keyboard requirements:** table content is reachable
- **Known race/idempotency constraints:** none
- **Source implementation:** `SettingsMyOrganismSection.tsx`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded

## Shared Settings table defaults

- **Behavior ID:** `react-settings-table-defaults`
- **Status:** normative
- **Affected route/component:** `SettingsNeoTable`
- **User role or permission:** authenticated user
- **Preconditions:** a Settings table initializes
- **User action or external event:** render table
- **Expected observable result:** toolbar, head-cell, paper styling, and table-ID behavior remain configured
- **Loading/empty/error/success behavior:** standard table states remain visible
- **URL, localStorage, or user-settings persistence:** configured table ID owns state
- **API endpoint and compatibility requirements:** none
- **Responsive and keyboard requirements:** enabled controls remain reachable
- **Known race/idempotency constraints:** none
- **Source implementation:** `SettingsNeoTable.tsx`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded

## Report-history presentation

- **Behavior ID:** `react-settings-report-history-presentation`
- **Status:** normative
- **Affected route/component:** `ReportHistoryTableSection`
- **User role or permission:** report-history viewer
- **Preconditions:** history has pages or cancellation-like rows
- **User action or external event:** page history or inspect a cancelled row
- **Expected observable result:** pagination and cancellation-like presentation remain stable
- **Loading/empty/error/success behavior:** history states remain distinct
- **URL, localStorage, or user-settings persistence:** configured table ID owns state
- **API endpoint and compatibility requirements:** `listReportHistory`
- **Responsive and keyboard requirements:** pagination is reachable
- **Known race/idempotency constraints:** none
- **Source implementation:** `SettingsMyReportsSection.tsx`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded

## Report actions and refresh behavior

- **Behavior ID:** `react-settings-report-actions`
- **Status:** normative
- **Affected route/component:** `ReportHistoryTableSection`
- **User role or permission:** owning table enables rerun
- **Preconditions:** completed report is downloadable/rerunnable
- **User action or external event:** download or rerun
- **Expected observable result:** download refreshes history and enabled rerun creates/reloads replacement
- **Loading/empty/error/success behavior:** refreshed history renders
- **URL, localStorage, or user-settings persistence:** table state only
- **API endpoint and compatibility requirements:** `downloadReportHistory`, `rerunSuccessfulReportHistory`
- **Responsive and keyboard requirements:** row actions reachable
- **Known race/idempotency constraints:** refresh prevents stale rows
- **Source implementation:** `SettingsMyReportsSection.tsx`
- **Existing tests:** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded
