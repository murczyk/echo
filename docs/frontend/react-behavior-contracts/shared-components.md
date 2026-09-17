# Shared components and browser boundaries

## Application-timezone date-time input

- **Status:** operational compatibility
- **Behavior ID:** `react-shared-app-timezone-datetime-input`
- **Affected route/component:** shared React date-time input utility
- **User role or permission:** any user entering an application date-time
- **Preconditions:** a date/time field uses the configured application timezone
- **User action or external event:** the user enters or views a `YYYY-MM-DDTHH:mm` value
- **Expected observable result:** valid local date-times round-trip through epoch milliseconds in the application timezone; malformed non-ISO separators are rejected.
- **Loading/empty/error/success behavior:** invalid/out-of-range input resolves to no timestamp.
- **URL, localStorage, or user-settings persistence:** callers own persistence.
- **API endpoint and compatibility requirements:** shared date-time values use the app timezone rather than the browser locale.
- **Responsive and keyboard requirements:** native date/time controls preserve their existing keyboard behavior.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `utils/misc.ts`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.

## Snackbar exit ordering

- **Status:** inferred characterization
- **Behavior ID:** `react-shared-snackbar-exit-ordering`
- **Affected route/component:** `PowerSnackbarProvider`
- **User role or permission:** any user receiving a queued application notification
- **Preconditions:** one snackbar is closing while another notification is queued
- **User action or external event:** the active notification is dismissed and its transition completes
- **Expected observable result:** duplicate notifications retain FIFO order; the active notification remains visible until its exit completes, and only then does the next queued notification become visible.
- **Loading/empty/error/success behavior:** queued notifications remain pending rather than being replaced or lost during the exit transition.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** existing alert role and dismissal controls remain available.
- **Known race/idempotency constraints:** a stale exit callback must not replace the currently owned queued notification.
- **Source implementation:** `src/ts/react/components/PowerSnackbar.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/components/__tests__/PowerSnackbar.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as a notification-ordering safeguard.

## Date and time draft ownership

- **Status:** inferred characterization
- **Behavior ID:** `react-shared-date-time-draft-ownership`
- **Affected route/component:** `PowerDatePicker`, `PowerDateTimePicker`, and `DateTimeRangeControl`
- **User role or permission:** any user editing a date or date-time filter.
- **Preconditions:** a controlled picker is open or a range preset is being changed.
- **User action or external event:** the user types, accepts, cancels, clears, uses a rolling preset, or the parent rerenders with stale/empty values.
- **Expected observable result:** drafts remain owned by the active edit until it is committed or dismissed; stale parent values cannot erase an in-progress edit, while a controlled clear restores the empty state. Accepted values, app-timezone presets, and global date bounds remain valid.
- **Loading/empty/error/success behavior:** disabled controls neither open nor apply presets.
- **URL, localStorage, or user-settings persistence:** callers own persistence.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** collapsed typing debounces the latest complete value and keyboard editing retains its active draft.
- **Known race/idempotency constraints:** pending typing and stale rerenders must not overwrite a newer user edit or submit an obsolete value.
- **Source implementation:** `PowerDateTimePicker.tsx`, `DateTimeRangeControl.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/components/__tests__/PowerDateTimePicker.spec.tsx`, `wdintel-web/src/ts/react/components/__tests__/DateTimeRangeControl.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as a form-data-loss safeguard.

## Navbar capability navigation and operator notices

- **Status:** inferred characterization
- **Behavior ID:** `react-navbar-capability-navigation`
- **Affected route/component:** `src/ts/react/components/app-navbar/AppNavbar.tsx` and its menu/dropdown components.
- **User role or permission:** every authenticated user; visible navigation depends on RER, Admin, Devices, AI-chat, transcription, and basic-user capabilities.
- **Expected observable result:** navigation exposes only routes the current feature state and roles permit. Database and administration groups retain their intentional grouping and ordering; mobile navigation remains operable; profile, changelog, and maintenance controls remain available when their prerequisites are met.
- **Loading/empty/error/success behavior:** while identity is loading, the profile control does not present an anonymous identity. A maintenance notice is shown once per deployment window and closes when that window ends.
- **Responsive and keyboard requirements:** mobile navigation can be opened and closed without changing the available route set; flyout and dropdown actions remain reachable.
- **Source implementation:** `src/ts/react/components/app-navbar/AppNavbar.tsx`, `menu-items.ts`, `ProfileDropdown.tsx`, and `ChangelogDropdown.tsx`.
- **Current retained test(s):** No direct default-suite test; behavior is preserved by this contract.

## Shared MRT table state, filters, and overflow

- **Status:** inferred characterization
- **Behavior ID:** `react-shared-mrt-state-and-overflow`
- **Affected route/component:** `src/ts/react/components/mui-customized/table/`.
- **User role or permission:** any table user.
- **Expected observable result:** table controls keep internal columns out of ordinary visibility menus, retain controlled visibility/order state, clear a writable global filter without mutating disabled or read-only controls, and distinguish filtered-empty from ordinary-empty results. Select-all affects only selectable rows.
- **Responsive and keyboard requirements:** overflowing values keep whole items and usable links intact, disclose hidden content without extra tab stops, and keep focus valid after a disclosure closes. Resizing and virtualization cannot expose stale measurement content.
- **Known race/idempotency constraints:** measurement work is bounded, shared among equivalent cells, abort-safe on unmount, and invalidated when fonts, visibility, virtualized row signatures, or widths change. Deferred offscreen work cannot block visible cells.
- **Source implementation:** `src/ts/react/components/mui-customized/table/get-default-table-options.tsx`, `mrt-overflow.tsx`, `table-state-provider.tsx`, and toolbar internal-action components.
- **Existing test(s):** `wdintel-web/src/ts/react/components/mui-customized/table/__tests__/table-state-provider.spec.ts`, `wdintel-web/src/ts/react/components/mui-customized/table/__tests__/mrt-overflow.spec.ts`, `wdintel-web/src/ts/react/components/__tests__/MrtRowActionButton.spec.tsx`, `wdintel-web/tests/e2e/mrt-overflow.spec.ts`

## Shared chip semantics

- **Status:** inferred characterization
- **Behavior ID:** `react-shared-chip-semantics`
- **Affected route/component:** `src/ts/react/components/EchoChip.tsx`.
- **Expected observable result:** chips distinguish tag, table, read-only, link, and button meanings through their native semantics; a read-only chip is not presented as a keyboard action.
- **Source implementation:** `src/ts/react/components/EchoChip.tsx`.

## PowerMenu accessibility label ownership

- **Status:** inferred characterization
- **Behavior ID:** `react-power-menu-accessibility-label`
- **Affected route/component:** `src/ts/react/components/PowerMenu.tsx`.
- **Expected observable result:** caller-provided menu labels remain associated with their invoking control.
- **Responsive and keyboard requirements:** assistive technology can identify the menu's invoking control.
- **Existing test(s):** `wdintel-web/src/ts/react/components/__tests__/PowerMenu.accessibility.spec.tsx`

## Bulk autocomplete selection

- **Status:** inferred characterization
- **Behavior ID:** `react-shared-bulk-autocomplete-selection`
- **Affected route/component:** `PowerAutocomplete` bulk paste and copy flow.
- **User role or permission:** any user editing a multi-value filter or selection.
- **Preconditions:** bulk paste is enabled and options may have inactive records, duplicate display labels, or already-selected values.
- **User action or external event:** the user copies selected values, pastes newline/comma-delimited input, cancels the dialog, or submits the resolved selection.
- **Expected observable result:** selected values can be copied through the caller-provided copy action and pasted into another compatible bulk flow. Canonical values round-trip; inactive bulk-only options remain selectable; ambiguous or missing entries are never silently chosen; duplicates and already-selected entries are previewed without duplicate submission. Newline-delimited free-form values retain embedded commas.
- **Loading/empty/error/success behavior:** an all-missing paste remains editable and cannot submit; a failed current resolution keeps submission disabled.
- **URL, localStorage, or user-settings persistence:** callers own persistence.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** closing the dialog returns focus to its menu trigger.
- **Known race/idempotency constraints:** option scanning is deferred until interaction and merged submission is idempotent for duplicate tokens.
- **Source implementation:** `PowerAutocomplete.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/components/__tests__/PowerAutocomplete.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as a selection/data-loss safeguard.

## Bulk autocomplete interaction shell

- **Status:** inferred characterization
- **Behavior ID:** `react-shared-bulk-autocomplete-interaction`
- **Affected route/component:** `PowerAutocomplete` bulk-action menu and dialog.
- **User role or permission:** any user editing a multi-value filter or selection.
- **Preconditions:** bulk paste or copy is enabled.
- **User action or external event:** the user opens the bulk menu, opens or cancels the dialog, or enters bulk input.
- **Expected observable result:** the dialog opens only when requested, identifies values already selected, and leaves ordinary autocomplete options unchanged. Copy is disabled when no values are selected.
- **Loading/empty/error/success behavior:** option scanning begins only after the dialog opens and input is entered; cancellation does not surface an aborted resolver as an error.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** closing the dialog returns focus to its bulk-menu trigger.
- **Known race/idempotency constraints:** closing an in-flight bulk-resolution session prevents its aborted completion from reporting an error into the next session.
- **Source implementation:** `PowerAutocomplete.tsx`.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.

## Alert dismissal policy

- **Status:** inferred characterization
- **Behavior ID:** `react-shared-alert-dismissal`
- **Affected route/component:** `PowerAlert`
- **User role or permission:** any user receiving an application alert.
- **Preconditions:** an alert has a severity and may specify an auto-hide duration or explicit dismissibility.
- **User action or external event:** an alert timeout elapses, the user dismisses an available control, or its content/severity changes.
- **Expected observable result:** alerts reset for new content; success and error use their shared timeout policy, info remains visible unless explicitly timed, and dismissal availability follows the shared severity policy.
- **Loading/empty/error/success behavior:** a closed alert is removed until a new alert state is supplied.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** dismissible alerts retain the underlying MUI alert control semantics.
- **Known race/idempotency constraints:** replacing alert content resets an earlier timeout instead of retaining a stale closed state.
- **Source implementation:** `PowerAlert.tsx`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.

## Searchable option selection

- **Status:** inferred characterization
- **Behavior ID:** `react-shared-searchable-option-selection`
- **Affected route/component:** `SearchableOptionAutocomplete`
- **User role or permission:** any user selecting an option by a stable numeric ID.
- **Preconditions:** a selected option may coexist with typed search text.
- **User action or external event:** the user types, explicitly selects an option, clears a clearable field, or leaves a non-clearable field.
- **Expected observable result:** typing changes only displayed search text; selection changes only through option selection or an allowed clear. Non-clearable fields restore the selected label on blur.
- **Loading/empty/error/success behavior:** a missing selected ID displays as no selection.
- **URL, localStorage, or user-settings persistence:** callers own persistence.
- **API endpoint and compatibility requirements:** option IDs remain stable numeric identifiers.
- **Responsive and keyboard requirements:** the underlying MUI autocomplete owns keyboard navigation.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `SearchableOptionAutocomplete.tsx`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.

## Saved-filter failure recovery

- **Status:** inferred characterization
- **Behavior ID:** `react-shared-saved-filter-failure-recovery`
- **Affected route/component:** `SavedFiltersControl`
- **User role or permission:** users allowed to save table-filter presets.
- **Preconditions:** the save-as-new dialog contains an entered name and its parent action may reject the save.
- **User action or external event:** the user submits a new saved filter and the action reports failure.
- **Expected observable result:** the dialog remains open with the entered draft available for correction or retry; the parent saved-filter name is not committed as a false success.
- **Loading/empty/error/success behavior:** successful persistence is parent-owned; failure leaves the local dialog active.
- **URL, localStorage, or user-settings persistence:** parent table state owns persistence.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** existing dialog controls retain their normal semantics.
- **Known race/idempotency constraints:** a failed completion cannot clear or commit the current draft.
- **Source implementation:** `SavedFiltersControl.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/components/__tests__/SavedFiltersControl.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as a draft-loss safeguard.

## Message-form keyboard submit

- **Status:** issue-backed regression
- **Behavior ID:** react-shared-message-form-keyboard-submit
- **Affected route/component:** shared React message form keyboard-submit handler and `PowerForm` wrapper
- **User role or permission:** users allowed to create or edit a message
- **Preconditions:** a form contains a supported single-line input or textarea and its current validation state is known.
- **User action or external event:** the user presses Enter, Ctrl/Cmd+Enter, Shift+Enter, Alt+Enter, Escape-composition input, or a browser has already consumed the event.
- **Expected observable result:** valid supported inputs submit once; invalid or composing input never submits; textarea content keeps plain/modified Enter semantics without accidental duplicate form submission.
- **Loading/empty/error/success behavior:** invalid input prevents the browser default but does not invoke requestSubmit.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** keyboard ownership remains with the active input and unsupported controls retain native behavior.
- **Known race/idempotency constraints:** a qualifying key event must issue one form submission only.
- **Source implementation:** `utils/formKeyboardSubmit.ts`, `PowerForm.tsx`.
- **Existing test(s):** `wdintel-web/src/ts/react/utils/__tests__/formKeyboardSubmit.spec.ts`, `wdintel-web/src/ts/react/components/__tests__/PowerForm.spec.tsx`.
- **Original Echo issue/PR, if known:** [#2746](https://github.com/echoua/echo/issues/2746).

## Frontend role hierarchy

- **Status:** inferred characterization
- **Behavior ID:** react-shared-role-hierarchy
- **Affected route/component:** shared frontend role/capability resolver
- **User role or permission:** all authenticated roles.
- **Preconditions:** a React route determines access to an action or Device capability.
- **User action or external event:** a role-gated control, route, or mutation is evaluated.
- **Expected observable result:** inherited roles match the backend hierarchy, while Device read/create/source/analytical capabilities remain action-specific.
- **Loading/empty/error/success behavior:** unauthorized roles receive no enabled capability.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** client-side gating supplements, but never replaces, backend authorization.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** none.
- **Source implementation:** utils/roles.ts.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded; retained as an authorization safeguard.

## AI-managed login selection

- **Status:** inferred characterization
- **Behavior ID:** react-shared-ai-managed-login-selection
- **Affected route/component:** shared login-option selection used by AI-managed settings.
- **User role or permission:** users allowed to edit the associated AI settings.
- **Preconditions:** a selection contains login IDs managed by the AI configuration.
- **User action or external event:** the user removes a keyboard selection or clears selected logins.
- **Expected observable result:** user-selected IDs update normally while AI-managed IDs remain selected.
- **Loading/empty/error/success behavior:** none.
- **URL, localStorage, or user-settings persistence:** callers own persistence.
- **API endpoint and compatibility requirements:** login IDs remain stable UUID values.
- **Responsive and keyboard requirements:** keyboard removal cannot bypass the managed-selection rule.
- **Known race/idempotency constraints:** none.
- **Source implementation:** utils/login-options.ts.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded; retained as a data-loss safeguard.

## Clipboard fallback

- **Status:** inferred characterization

- **Behavior ID:** `react-shared-clipboard-fallback`
- **Affected route/component:** shared clipboard helper used by message, table, map, Duty, GOI, and user controls
- **User role or permission:** any user offered a copy action
- **Preconditions:** a copy action has text to write; the browser may deny or omit `navigator.clipboard`
- **User action or external event:** the user activates copy after asynchronous UI work
- **Expected observable result:** a working Clipboard API is used directly; a denied/unavailable API falls back to a temporary selected textarea; callers receive a rejection when both mechanisms fail.
- **Loading/empty/error/success behavior:** fallback DOM nodes are always removed after success or failure.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none; this is a browser capability boundary.
- **Responsive and keyboard requirements:** copy remains available to all existing keyboard-triggered controls.
- **Known race/idempotency constraints:** no false success may be reported after both copy mechanisms fail.
- **Source implementation:** `src/ts/copy-to-clipboard.ts`
- **Existing test(s):** `wdintel-web/src/ts/copy-to-clipboard.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as a browser-failure safeguard.

## Image clipboard conversion

- **Status:** inferred characterization

- **Behavior ID:** `react-shared-image-clipboard-safety`
- **Affected route/component:** message-card image attachment copy action
- **User role or permission:** users offered an image copy action
- **Preconditions:** an image preview is loaded and the browser exposes image clipboard APIs
- **User action or external event:** the user copies an image while canvas conversion or clipboard write may fail
- **Expected observable result:** clipboard writing starts inside the activation window with a promised canvas PNG; failed canvas/write paths retry using the credentialed fetched image blob; unsupported/non-image content is rejected and unavailable browsers do not offer a false executable action.
- **Loading/empty/error/success behavior:** failures remain visible to the caller instead of reporting a successful copy.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** source-image fetches retain credentials.
- **Responsive and keyboard requirements:** existing copy controls retain their keyboard behavior.
- **Known race/idempotency constraints:** activation-sensitive clipboard write is issued before asynchronous canvas completion.
- **Source implementation:** `copy-image-to-clipboard.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/shared/message-card/__tests__/copy-image-to-clipboard.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as browser/resource safeguards.

## Manage-message attachment and edit safety

- **Status:** inferred characterization
- **Behavior ID:** `react-manage-message-attachment-and-edit-safety`
- **Affected route/component:** Manage Message drawer and its failed-upload fallback.
- **User role or permission:** users permitted to create or edit messages and reports.
- **Preconditions:** an editable linked/report message has attachments or an upload attempt.
- **User action or external event:** the user edits a linked/report message, removes an attachment, or a TUS upload fails.
- **Expected observable result:** regular linked-message edits do not mutate accessible parents; report edits do not copy inaccessible parents; a recoverable upload failure falls back to multipart and preserves its uploaded URL, while authentication failures are not retried through another transport.
- **Loading/empty/error/success behavior:** recoverable uploads continue through multipart; terminal authentication failures remain visible failures.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** attachment removal and fallback uploads preserve the established message and multipart request contracts.
- **Responsive and keyboard requirements:** drawer attachment controls retain their existing keyboard behavior.
- **Known race/idempotency constraints:** removing a file clears its tracked failure; terminal authentication failures remain terminal.
- **Source implementation:** `routes/shared/manage-message/ManageMessageDrawer.tsx`, `message-upload-fallback.ts`.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/shared/manage-message/__tests__/ManageMessageDrawer.edit.spec.tsx` and `wdintel-web/src/ts/react/routes/shared/manage-message/__tests__/message-upload-fallback.spec.ts`.
- **Original Echo issue/PR, if known:** none recorded; retained as data and attachment integrity safeguards.

## Manage-message required report content

- **Status:** inferred characterization
- **Behavior ID:** `react-manage-message-required-report-content`
- **Affected route/component:** Manage Message report submission form.
- **User role or permission:** users permitted to create or edit report messages.
- **Preconditions:** the drawer is configured for a report message.
- **User action or external event:** the user attempts to submit without report text.
- **Expected observable result:** report submission requires non-empty report text.
- **Loading/empty/error/success behavior:** an empty report remains unsubmitted until content is provided.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** no report submission request is made without required content.
- **Responsive and keyboard requirements:** the existing form validation remains available to keyboard users.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `routes/shared/manage-message/ManageMessageDrawer.tsx`.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.

## Portal-aware outside dismissal

- **Status:** inferred characterization

- **Behavior ID:** `react-shared-portal-click-away`
- **Affected route/component:** shared click-away hook used by transient React panels
- **User role or permission:** any user interacting with a panel and nested portal control
- **Preconditions:** a panel is open and specifies portal roots that are part of its active interaction
- **User action or external event:** the user clicks an action in an ignored portal or a true outside target
- **Expected observable result:** modal/portal actions do not dismiss the underlying panel; an unrelated outside click dismisses it.
- **Loading/empty/error/success behavior:** none.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** portal click handling must not interfere with native dialog interaction.
- **Known race/idempotency constraints:** an in-progress portal action must not lose its parent panel through the capture-phase click listener.
- **Source implementation:** `src/ts/react/hooks/use-document-click-away.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/hooks/__tests__/use-document-click-away.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as a dismissal safeguard.
