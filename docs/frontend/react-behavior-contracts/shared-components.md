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
- **Existing test(s):** `utils/misc.spec.ts`
- **Original Echo issue/PR, if known:** none recorded.

## Snackbar exit ordering

- **Status:** inferred characterization
- **Behavior ID:** `react-shared-snackbar-exit-ordering`
- **Affected route/component:** `PowerSnackbarProvider`
- **User role or permission:** any user receiving a queued application notification
- **Preconditions:** one snackbar is closing while another notification is queued
- **User action or external event:** the active notification is dismissed and its transition completes
- **Expected observable result:** the active notification remains visible until its exit completes; only then does the next queued notification become visible.
- **Loading/empty/error/success behavior:** queued notifications remain pending rather than being replaced or lost during the exit transition.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** existing alert role and dismissal controls remain available.
- **Known race/idempotency constraints:** a stale exit callback must not replace the currently owned queued notification.
- **Source implementation:** `src/ts/react/components/PowerSnackbar.tsx`
- **Existing test(s):** `PowerSnackbar.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as a notification-ordering safeguard.

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
- **Existing test(s):** `src/ts/copy-to-clipboard.spec.ts`
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
- **Existing test(s):** `copy-image-to-clipboard.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as browser/resource safeguards.

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
- **Existing test(s):** `use-document-click-away.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as a dismissal safeguard.
