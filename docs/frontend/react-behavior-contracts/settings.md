# Settings

## Report destination memory

- Duty and Analysis each expose «Розвіддонесення: зберігати вибір групи» in
  their settings tab. Both default to enabled, including missing values from
  older responses and unset database columns.
- `dutyRememberReportGroup` and `analysisRememberReportGroup` persist
  independently through `/api/user/settings`; older clients that omit them
  preserve the stored values.
- Disabling a page's switch leaves new reports without a preselected group and
  stops updating the remembered destination from that page. Manual selection
  still works. Editing existing reports keeps their destination. The minimal
  Duty report window uses the remembered destination when enabled and saves
  without sending to a group when disabled.
- Coverage: `wdintel-web/tests/e2e/manage-message-drawer.spec.ts` and
  `wdintel-rs/src/user_settings/functional_tests.rs`.

## Duty card visibility

- The Duty tab's «Картка повідомлення» block has «Показувати в Оперативному:»
  switches for the card header, frequency and unit. All are on by default,
  including missing values from older responses and unset database columns.
  The frequency switch appears only for users with radio features.
- `dutyHideCardHeader`, `dutyHideCardFrequency` and `dutyHideCardUnit` persist
  through `/api/user/settings`; older clients that omit them preserve the stored
  values. Analysis cards and the Analysis tab ignore them.
- On the Duty tab the card preview reflects the three choices.

## Narrow-card quick actions

- The «Картка повідомлення» block on the Duty and Analysis tabs has shared
  «Швидкі дії» selectors (count 1 or 2, default 2). With 2 it shows
  «Швидка дія 1» and «Швидка дія 2», with a «−» button beside the second that
  removes it; with 1, a single «Швидка дія» with a «+» button to its right that
  adds the second. Focus moves to the new second selector, or back to «+».
  The second defaults to «Позначити як важливе».
- Choosing the other slot's action swaps the two selectors and saves both.
  Unrelated saves omit `messageCardQuickAction` and
  `messageCardSecondQuickAction` so their server defaults stay unset.
- The card preview shows the selected actions in slot order. It sits at the top
  of the block under the «Картка повідомлення» title row and, with that row,
  stays pinned below the navbar while the block's settings scroll. In windows
  narrower than the `md` breakpoint or shorter than 900px, a «Сховати/Показати
  перегляд картки» control in the title row collapses it (icon-only below `sm`). The settings card and `<settings-neo>` host use
  `overflow: clip` so the page stays the sticky scroll container.
- Coverage: `wdintel-web/tests/e2e/message-card-quick-action.spec.ts` and
  `wdintel-rs/src/user_settings/functional_tests.rs`.
- Original Echo issue: [#4219](https://github.com/echoua/echo/issues/4219)
- Coverage: `wdintel-web/tests/e2e/rer-duty-card-visibility.spec.ts`,
  `wdintel-web/src/ts/react/routes/shared/message-card/__tests__/MessageCard.spec.tsx`
  and `wdintel-rs/src/user_settings/functional_tests.rs`.
- Original Echo issue: [#4219](https://github.com/echoua/echo/issues/4219)

## Analysis time-basis regression

- **Behavior ID:** `react-settings-analysis-time-basis`
- **Status:** issue-backed regression
- **Affected route/component:** `SettingsNeoPage`, `SettingsAnalysisTimeBasisCard`
- **User role or permission:** authenticated user
- **Preconditions:** settings render
- **User action or external event:** open settings
- **Expected observable result:** the time-basis control appears and persists only in Analysis settings; Duty retains the shared message-card controls without exposing this Analysis preference
- **Loading/empty/error/success behavior:** normal settings loading
- **URL, localStorage, or user-settings persistence:** user settings
- **API endpoint and compatibility requirements:** `services/api/user-settings.saveUserSettings`
- **Responsive and keyboard requirements:** controls are keyboard reachable
- **Known race/idempotency constraints:** none
- **Source implementation:** `wdintel-web/src/ts/react/routes/settings-neo/SettingsAnalysisTimeBasisCard.tsx`, `wdintel-web/src/ts/react/routes/settings-neo/index.tsx`
- **Existing tests:** `wdintel-web/src/ts/react/routes/settings-neo/__tests__/index.spec.tsx`
- **Original Echo issue/PR, if known:** [#3546](https://github.com/echoua/echo/issues/3546)

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

## Profile label identity

- **Behavior ID:** `react-settings-profile-label-identity`
- **Expected observable result:** saving or clearing a display name preserves the underlying login and failed edits do not erase it.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/settings-neo/__tests__/SettingsProfileSection.spec.tsx`
- **Original Echo issue/PR, if known:** [#3575](https://github.com/echoua/echo/issues/3575)

## System-setting persistence

- **Behavior ID:** `react-system-settings-persistence`
- **Expected observable result:** disabling the Duty minus menu, the Duty selected-groups indicator, or 2FA persists through save and the next load reflects the disabled state. «ШІ: головна мережа повідомлення» is off by default; enabling it persists through save and reload, and saves from older admin clients keep its stored value ([#4095](https://github.com/echoua/echo/issues/4095)).
- **Existing test(s):** `wdintel-web/src/ts/react/routes/admin-system-settings-neo/__tests__/index.spec.tsx`
- **Original Echo issue/PR, if known:** [#3568](https://github.com/echoua/echo/issues/3568)

## API quota settings

- **Behavior ID:** `react-api-quota-settings`
- **Expected observable result:** the API tab loads and saves independent quota values; defaults are 500 ms and burst 5, invalid individual or combined values show an error without saving, and failed saves retain edits.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/admin-system-settings-neo/__tests__/index.spec.tsx`
- **Original Echo issue/PR, if known:** [#3788](https://github.com/echoua/echo/issues/3788)
- **Settings and reconciliation contract:** [API request limits](../../api-rate-limiting.md).

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
- **Expected observable result:** omitted or unsupported settings normalize to `analysisMapInSidebar: false`, `dutyAudioTranscriptionCollapsed: false`, `analysisAudioTranscriptionCollapsed: false`, `showAnalysisCallsignAddForm: false`, `showClassicDuty: false`, `showClassicAnalysis: false`, `dutyCollapseMediaPreviews: true`, `mediaSummaryEnabled: false`, `minimalReportWindowEnabled: false`, `importantOnlyMyOrganism: false`, `dutyHideCardHeader: false`, `dutyHideCardFrequency: false`, `dutyHideCardUnit: false`, `messageCardQuickActionCount: 2`, `messageCardSecondQuickAction: important`, `messageTextPreviewLines: 20`, and `messageSortBy: interception`.
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
- **Expected observable result:** tab, empty state, table, and feature-flagged editing appear. Help distinguishes administrator-created Echo groups from messenger connection instructions and explains that group administration does not grant access to messages.
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

## Report administration

- Administrators manage report chunking, size restrictions, and concurrency in
  `/admin/system-settings-neo#reports`. Defaults are 4 globally, 1 per non-Etalonka
  kind, and 2 for Etalonka. New limits apply to subsequent claims; running jobs
  finish normally. Etalonka jobs remain sequential for each user.
- The independent RER block retains its enable toggle, eligible-user list,
  metadata editor, retry behavior, and existing report visibility rules. Saving
  the general settings after toggling RER must preserve the RER toggle.
- All Reports displays report history. Legacy `?tab=rer-report` links navigate to
  Reports settings while retaining metadata filters.
- Restart requires confirmation and invokes only the administrator endpoint
  `/api/admin/restart-report-worker`. It restarts the report service and shows
  failures without reporting success.
- Coverage: `wdintel-web/tests/e2e/report-settings.spec.ts`,
  `wdintel-web/tests/e2e/rer-report-admin.spec.ts`,
  `wdintel-web/src/ts/react/routes/admin-all-reports/__tests__/index.spec.tsx`, and
  `wdintel-web/src/ts/react/routes/admin-system-settings-neo/__tests__/RerReportSettings.spec.tsx`.

## Monitoring administration

- Administrators enable SigNoz metrics export and set its OTLP gRPC address in
  `/admin/system-settings-neo#monitoring`. The values are part of the versioned
  system settings, replace the `config.toml` keys, and apply only after Echo
  and the report worker restart; the tab says so and links to the Echo restart
  on the Control tab and the report worker restart on the Reports tab.
- Saving always sends the switch and the trimmed address, empty as `null`.
  Enabling without an address, or entering an address that is not an http(s) URL
  with a host, shows an error without saving; the backend rejects the same input.
- Coverage: `wdintel-web/src/ts/react/routes/admin-system-settings-neo/__tests__/index.spec.tsx`.
- Original Echo issue: [#4034](https://github.com/echoua/echo/issues/4034)
