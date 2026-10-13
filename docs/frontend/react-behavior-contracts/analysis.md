# Analysis

## Analysis API compatibility

- **Status:** operational compatibility

- **Behavior ID:** `react-analysis-api-compatibility`
- **Affected route/component:** analysis search, callsign information, message retrieval, and direct submission boundaries
- **User role or permission:** users authorized to inspect or mutate the current analysis data
- **Preconditions:** analysis criteria or message IDs are submitted
- **User action or external event:** the user searches callsign frequencies, loads messages, submits a message, or records a model/tag action origin
- **Expected observable result:** normalized analysis criteria and ContentNode variants survive the wire boundary; callsign edits preserve their explicit action IDs together with added and removed callsigns; sender statistics use returned profile names and network statistics hydrate missing unit names for user-facing filter labels; highlight context and optional action origins are preserved without altering the business request body.
- **Loading/empty/error/success behavior:** absent optional origins retain the legacy-compatible request shape.
- **URL, localStorage, or user-settings persistence:** analysis route state owns persistence.
- **API endpoint and compatibility requirements:** callsign lookup and message APIs accept established request fields and normalize supported legacy response fields.
- **Responsive and keyboard requirements:** none at the API boundary.
- **Known race/idempotency constraints:** none in the mapper itself.
- **Source implementation:** `src/ts/react/services/api/analysis.ts`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded; retained as operational compatibility coverage.

## AI-agent API compatibility

- **Status:** operational compatibility

- **Behavior ID:** `react-ai-agent-api-compatibility`
- **Affected route/component:** AI-agent audit/conversation views and dispatcher administration
- **User role or permission:** users with AI-agent visibility; administrators for dispatcher configuration
- **Preconditions:** an AI-agent cancellation, audit, conversation title update, or dispatcher save is requested
- **User action or external event:** the user cancels a request, inspects audit activity, renames a conversation, or saves dispatcher settings
- **Expected observable result:** cancellation uses the authoritative returned state; audit tool activity and retries normalize without leaking raw reasoning; conversation messages receive stable unique keys; dispatcher saves include only editable fields.
- **Loading/empty/error/success behavior:** null retry values survive normalization.
- **URL, localStorage, or user-settings persistence:** none at the API boundary.
- **API endpoint and compatibility requirements:** generated request/response fields remain wire-compatible.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** the latest cancellation state returned by the server wins.
- **Source implementation:** `src/ts/react/services/api/ai-agent.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/services/api/__tests__/ai-agent.spec.ts`
- **Original Echo issue/PR, if known:** none recorded.

## Radio-filter access

- **Behavior ID:** `react-analysis-radio-filter-access`
- **Expected observable result:** non-Rer users do not receive frequency or network radio controls; restored radio filters and hidden tabs do not become active, while Rer access remains available after current-user reconciliation.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx`, `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisFiltersPanel.spec.tsx`
- **Original Echo issue/PR, if known:** [#3568](https://github.com/echoua/echo/issues/3568)

## Analysis role-aware date defaults

- **Behavior ID:** `react-analysis-role-aware-date-defaults`
- **Expected observable result:** a bare Rer Analysis query defaults to today, while a bare non-Rer query defaults to the preceding 90-day range.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/helpers.spec.ts`, `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx`
- **Original Echo issue/PR, if known:** [#3568](https://github.com/echoua/echo/issues/3568)

## Analysis query state normalization

- **Status:** inferred characterization

- **Behavior ID:** `react-analysis-query-state-normalization`
- **Affected route/component:** RER Analysis URL, saved-filter, and request helper boundary
- **User role or permission:** users allowed to run analysis queries
- **Preconditions:** URL parameters, saved-filter state, or a query form provides analysis selections
- **User action or external event:** the user restores/shares a URL, applies a saved filter, changes filters, or submits a query
- **Expected observable result:** managed URL state wins over unsupported legacy state; selected tag/callsign/unit/device/media/coordinate selections normalize into the correct request surface; malformed or inverted bounds produce no request.
- **Loading/empty/error/success behavior:** invalid time bounds produce no request rather than a misleading date range.
- **URL, localStorage, or user-settings persistence:** saved filters intentionally omit inbox-only selections while URL state retains managed selections.
- **API endpoint and compatibility requirements:** null/default request values preserve backend defaults and legacy unit aliases normalize before use.
- **Responsive and keyboard requirements:** none at the helper boundary.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `routes/rer-analysis-neo/helpers.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/helpers.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational parser coverage.

## Analysis query defaults and interaction state

- **Status:** inferred characterization
- **Behavior ID:** `react-analysis-query-defaults-and-interaction-state`
- **Affected route/component:** RER Analysis query state and direct-link handling.
- **User role or permission:** users allowed to view or run analysis queries.
- **Preconditions:** the analysis route initializes, a saved filter is applied, or a direct message link opens.
- **User action or external event:** the user changes filters, opens a direct message, follows a map link, or restores query state.
- **Expected observable result:** date-only differences do not mark a saved filter dirty, non-date differences do, `onlyWithMedia` affects UI dirty state but not saved-filter equality, initial `unitsExactMatchOnly` is null, defaults span one day with Rer access or 90 days otherwise in the application timezone, direct links preserve or recenter the interception or creation range as described below and do not fall back when creation time is unavailable, saved filters reset adjacent-frequency expansion, and only `showMap=true` enables the map.
- **Loading/empty/error/success behavior:** unavailable creation time leaves the current direct-link range unchanged.
- **URL, localStorage, or user-settings persistence:** URL `showMap` is accepted only for the literal value `true`; saved-filter equality intentionally excludes `onlyWithMedia`.
- **API endpoint and compatibility requirements:** initial null unit matching preserves the backend default.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** applying a saved filter clears stale adjacent-frequency expansion.
- **Source implementation:** `routes/rer-analysis-neo/helpers.ts`.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.

## Analysis direct-link dates

Opening `/rer-analysis-neo?m=<message-reference>` resolves an accessible message
through `/api/rer-importer/inbox-item-context`, independently of the date filter.
Access restrictions still apply. The selected period is set before requesting
surrounding messages through `/api/rer-importer/get-inbox` with `around_message_ref`.
That request retains all filters and requires valid, ordered date boundaries. Missing or inaccessible
messages retain the normal range and show the existing error notification. If
the bounded window is unavailable or fails, restore the previous period; a stale
response must never restore dates after user navigation.

The initial range uses the resolved role defaults (one day with Rer access,
90 days otherwise), or explicit URL dates, and the saved Analysis time basis.
A message inside the start-inclusive, end-exclusive range leaves it unchanged.
Otherwise the range moves around the message while preserving its size:

- Calendar-day ranges stay on midnight boundaries in the application timezone
  (`Europe/Kiev`), including across daylight-saving changes. One day shows the
  message's day. Ninety days includes 45 days before it and 44 days after it.
- Custom datetime ranges preserve their elapsed duration and center on the
  message's minute; odd minute counts put the extra minute after that minute.
- Interception mode uses the message's date and time, falling back to its
  timestamp when unavailable. A date without a time uses midnight; `isTimeNull`
  overrides any legacy placeholder time. Creation
  mode uses only `createdAt`; a missing creation timestamp leaves dates unchanged.
- Invalid ranges are left for the existing date validation. Future dates are
  not clamped to today.

Adjusted dates are persisted in the URL with the message reference and other
filters. Role/settings initialization and automatic adjustment preserve focus.
User date or search edits leave direct-message navigation and invalidate a
pending lookup or surrounding-message response. Earlier/later pages keep the same
date boundaries. The before/after counts and pagination totals describe only that
period; widening the date selection explicitly loads and counts the wider period.
No direct-link request counts all history.

Regression coverage:

- `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/helpers.spec.ts`
- `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx`
- `wdintel-web/tests/e2e/analysis-neo.spec.ts`

## Analysis report request compatibility

- **Status:** operational compatibility
- **Behavior ID:** `react-analysis-report-request-compatibility`
- **Affected route/component:** RER Analysis report request builder.
- **User role or permission:** users allowed to generate analysis reports.
- **Preconditions:** a report template and analysis request are selected.
- **User action or external event:** the user submits a report request.
- **Expected observable result:** report template 1.2.5 uses the compatible report kind, tag sorting is sent only for tag reports, and a trimmed Sposob unit name is sent only for Sposob reports.
- **Loading/empty/error/success behavior:** unsupported optional template fields are omitted rather than sent on another report kind.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** preserves report request `kind`, `tagReportSortBy`, and `sposobUnitName` wire compatibility.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `routes/rer-analysis-neo/report-helpers.ts`.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded; retained as operational parser coverage.

## Analysis report presentation and defaults

- **Status:** inferred characterization
- **Behavior ID:** `react-analysis-report-presentation-defaults`
- **Affected route/component:** RER Analysis report dialog helpers.
- **User role or permission:** users allowed to configure analysis reports.
- **Preconditions:** the report dialog renders a selected template.
- **User action or external event:** the user views report hints, titles, download options, or default report settings.
- **Expected observable result:** report hints and titles identify the selected template; KMZ, GeoJSON, and DOCX downloads retain appropriate metadata; default tag sorting remains available.
- **Loading/empty/error/success behavior:** missing optional report metadata does not prevent the dialog from rendering its default state.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none beyond the established report request representation.
- **Responsive and keyboard requirements:** report labels remain available to the existing dialog controls.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `routes/rer-analysis-neo/report-helpers.ts`.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.

## Callsign hint resolution

- **Status:** operational compatibility

- **Behavior ID:** `react-analysis-callsign-hint-resolution`
- **Affected route/component:** RER Analysis callsign hint and tooltip resolver
- **User role or permission:** users able to inspect analysis messages and frequency context
- **Preconditions:** callsign information, assigned/message/frequency network IDs, and hierarchy data are available
- **User action or external event:** the user views message or frequency callsign hints
- **Expected observable result:** exact/candidate/catalog/other-network hints classify correctly; network and unit hierarchy scope restricts rows to the relevant formation/region; missing optional API fields safely resolve without a crash; tooltip rows preserve priority/order and omit non-visible/comment-only content.
- **Loading/empty/error/success behavior:** empty/missing callsign information is unresolved/no hint rather than a malformed tooltip.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** supports legacy/missing `networkIdsReportedIn` and exact/network fallback response shapes.
- **Responsive and keyboard requirements:** tooltip text remains concise for the existing accessible hint control.
- **Known race/idempotency constraints:** message context must not mix rows from another network/region after data refresh.
- **Source implementation:** `routes/rer-analysis-neo/callsign-hints.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/callsign-hints.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational parser coverage.

## Analysis filter and map loading behavior

- **Status:** inferred characterization
- **Behavior ID:** `react-analysis-filter-and-map-loading`
- **Affected route/component:** RER Analysis lazy filter sections and map message loading.
- **Expected observable result:** initial loads include required filter facets and selected lazy facets; later loads reuse loaded or targeted facets. An opened lazy section shows loading rather than a false empty state. Filter labels retain returned statistics and hydrated network/unit names; duplicate group labels merge without losing selected master keys, callsign labels are displayed in uppercase without changing submitted values, and networks use their statistics labels and ordering. The device filter appears only when Cyber Echo is enabled, while frequency bulk input accepts comma and newline separators. Each counter reload clears previous totals. Unfinished or failed dimensions use an em dash; successful dimensions independently show their selected and total counts, including genuine zeroes. Exact-match controls appear only for applicable selected values, reflect an explicit query value or the loaded default, and map their checked state to the corresponding query mode without changing while counts load. Disabling peleng also clears the dependent without-coordinates option. Map message IDs are filtered before fetches, and messages absent from a map response are not rendered as map points. A backend page shorter than its supplied limit ends pagination; no exhaustion is inferred when that limit is absent.
- **Known race/idempotency constraints:** invalidated or stale filter and map responses cannot replace current state.
- **Authorization errors:** every current counter error is checked for session expiry before ordinary error notifications are deduplicated.
- **Source implementation:** `routes/rer-analysis-neo/use-analysis-data-filter-sections.ts`, `use-analysis-data.loaders.ts`, and `use-analysis-data.shared.ts`.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-data.reload.spec.ts`, `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisFiltersPanel.spec.tsx`.

## Analysis message-list stale-response safety

- **Status:** inferred characterization

- **Behavior ID:** `react-analysis-message-list-stale-response-safety`
- **Affected route/component:** RER Analysis message list enrichment and pagination state
- **User role or permission:** users viewing analysis messages
- **Preconditions:** enrichment or page hydration requests overlap with a newer refresh/invalidation
- **User action or external event:** a late response arrives after ownership, cursor, or page state changed
- **Expected observable result:** stale enrichment cannot overwrite current callsign ownership or block a later update; refreshed unscoped data is not suppressed by a prior scoped result; duplicate requests are coalesced; stale hydrated pages cannot advance the cursor/index; invalidated pages re-enrich preserved messages and ignore late enrichment.
- **Loading/empty/error/success behavior:** a failed enrichment releases ownership for a later retry.
- **URL, localStorage, or user-settings persistence:** pagination cursors remain route state.
- **API endpoint and compatibility requirements:** none beyond established analysis message responses.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** response ordering and invalidation must win over stale async completion.
- **Source implementation:** `use-analysis-message-list.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-message-list.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as concurrency safeguards.

## Bounded Analysis message feed

Analysis retains at most 40 message payloads and mounted cards per feed. Scrolling
loads 20-message pages from either edge and evicts the opposite edge; an evicted
page can be fetched again. The page owns the limit, cursors, and logical message
coordinates. The shared `MessageFeed` owns viewport anchoring and edge skeletons,
not the data window. This also applies to direct-message context, refresh, and
realtime insertion. Filter and sort changes invalidate older requests.
If a page arrives during wheel input, the shared feed keeps the current cards
and edge skeleton until wheel and inertial scroll events are idle for ~140ms. Wheel input is never
blocked; only the visual window commit waits.

The first/previous/next/last controls and scroll-driven page selection share the
same logical page and `messagesPage` URL state. A button click additionally aligns
the requested page; ordinary scrolling does not jump. The range label uses the
selected page and total count, including a partial final page, rather than the
number of cards currently mounted.

Regression coverage: `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-message-list.spec.ts`,
`wdintel-web/src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisPaginationControl.spec.tsx`,
and `wdintel-web/tests/e2e/message-feed-unification.spec.ts`.

## Analysis filter-facet invalidation

- **Status:** inferred characterization

- **Behavior ID:** `react-analysis-filter-facet-invalidation`
- **Affected route/component:** RER Analysis lazy filter-section loader
- **User role or permission:** users able to run analysis queries
- **Preconditions:** filter facets have loaded or are loading while a targeted query or tag change invalidates them
- **User action or external event:** the user changes a scoped filter or a tag, a facet request fails, or a late facet response arrives
- **Expected observable result:** invalidated facets remain queued and stale until a current reload succeeds; tag changes refetch tag counts; an obsolete completion cannot erase the required reload.
- **Loading/empty/error/success behavior:** failed targeted loads remain retryable instead of silently showing a complete but stale facet.
- **URL, localStorage, or user-settings persistence:** query-state persistence remains route-owned.
- **API endpoint and compatibility requirements:** established filter-section response shapes remain unchanged.
- **Responsive and keyboard requirements:** none at the loader boundary.
- **Known race/idempotency constraints:** request-version invalidation wins over late facet completions, including before React has propagated loading state.
- **Source implementation:** `routes/rer-analysis-neo/use-analysis-data-filter-sections.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-data-filter-sections.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as concurrency safeguards.

## Analysis reload orchestration

- **Status:** inferred characterization

- **Behavior ID:** `react-analysis-reload-orchestration`
- **Affected route/component:** RER Analysis reload orchestrator
- **User role or permission:** users running or refining analysis queries
- **Preconditions:** an analysis load is active or a reload trigger changes within the debounce window
- **User action or external event:** the user changes query state rapidly, reverts a change, switches to summary, or leaves the page
- **Expected observable result:** only the latest query reload runs; reverting a change schedules the restored query; summary loading waits for the active reload; a superseded or unmounted page reload is aborted.
- **Loading/empty/error/success behavior:** summary loading does not briefly present data for a query that is still being replaced.
- **URL, localStorage, or user-settings persistence:** query trigger state remains route-owned.
- **API endpoint and compatibility requirements:** reload requests retain the established analysis data boundary and abort signal.
- **Responsive and keyboard requirements:** none at the orchestration boundary.
- **Known race/idempotency constraints:** the latest reload key owns the abort controller and timer; cleanup must prevent post-unmount work.
- **Source implementation:** `routes/rer-analysis-neo/use-analysis-reload-orchestrator.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-reload-orchestrator.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as concurrency safeguards.

## Targeted inbox reconciliation

- **Status:** inferred characterization

- **Behavior ID:** `react-analysis-targeted-inbox-reconciliation`
- **Affected route/component:** RER Analysis targeted inbox reconciliation hook
- **User role or permission:** users viewing analysis messages
- **Preconditions:** one or more message updates require reconciliation while an earlier batch is still active
- **User action or external event:** another update for the same message arrives, or the analysis page unmounts before the batch settles
- **Expected observable result:** repeated IDs coalesce into one current follow-up batch; only the newest response may apply; unmount aborts the request and prevents post-unmount state application.
- **Loading/empty/error/success behavior:** no obsolete response is displayed after a newer reconciliation request.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** reconciliation receives the established abort signal without changing API payloads.
- **Responsive and keyboard requirements:** none at the reconciliation boundary.
- **Known race/idempotency constraints:** per-message version ownership wins over earlier batches.
- **Source implementation:** `routes/rer-analysis-neo/use-targeted-inbox-reconciliation.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-targeted-inbox-reconciliation.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as concurrency safeguards.

## Analysis comment hydration ordering

- **Status:** inferred characterization

- **Behavior ID:** `react-analysis-comment-hydration-ordering`
- **Affected route/component:** RER Analysis message-comment loader
- **User role or permission:** users viewing message comments
- **Preconditions:** a comment batch is loading when analysis message state is invalidated
- **User action or external event:** a late comment response resolves after the request version changes
- **Expected observable result:** the obsolete batch does not update the current message comments or emit an error.
- **Loading/empty/error/success behavior:** a current response still populates missing comment entries normally.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** comment request and response shapes remain unchanged.
- **Responsive and keyboard requirements:** none at the loader boundary.
- **Known race/idempotency constraints:** request-version ownership wins over late comment hydration.
- **Source implementation:** `routes/rer-analysis-neo/use-analysis-data.comments.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-data.comments.load.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as a concurrency safeguard.

## Analysis message mutation integrity

- **Status:** inferred characterization

- **Behavior ID:** `react-analysis-message-mutation-integrity`
- **Affected route/component:** RER Analysis message tag and point-blacklist actions
- **User role or permission:** users authorized to change message tags or point highlight blacklists
- **Preconditions:** a tag or blacklist mutation is in progress, fails, is duplicated, or receives an authorization failure
- **User action or external event:** the user toggles a tag, blacklists a point, repeats a request, or the server responds after an event/lost-response race
- **Expected observable result:** failed optimistic tag state remains visible and reconcilable; duplicate blacklist requests coalesce; both message and map collections stay consistent; 401 errors use the existing unauthorized path.
- **Loading/empty/error/success behavior:** ordinary failures surface an error without corrupting local state.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** tag and blacklist endpoint payloads remain unchanged.
- **Responsive and keyboard requirements:** none at the mutation boundary.
- **Known race/idempotency constraints:** event-origin reconciliation and blacklist request keys prevent stale or duplicate local state changes.
- **Source implementation:** `routes/rer-analysis-neo/use-analysis-data.message-actions.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-data.message-actions.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as integrity and authorization safeguards.

## Analysis linked-message edit ownership

- **Status:** inferred characterization
- **Behavior ID:** `react-analysis-linked-message-edit-ownership`
- **Affected route/component:** RER Analysis message editor.
- **User action or external event:** the user edits a linked message with an accessible parent.
- **Expected observable result:** the message opens in regular edit mode and saves only that message; it is not converted into a report edit or copied from its parent.
- **Known race/idempotency constraints:** the chosen edit mode must remain associated with the selected message.
- **Source implementation:** `routes/rer-analysis-neo/index.tsx`.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/index.spec.tsx`.
- **Original Echo issue/PR, if known:** none recorded; retained as a data-integrity safeguard.

## Analysis filter draft continuity

- **Status:** inferred characterization
- **Behavior ID:** `react-analysis-filter-draft-continuity`
- **Affected route/component:** `AnalysisFilterField`
- **User action or external event:** the user types or changes a deferred filter while options refresh, the menu remains open, or the menu closes.
- **Expected observable result:** in-progress search text and deferred selections are not lost or replayed from an older draft; an explicit selection, clear, or bulk paste applies the appropriate current value.
- **Known race/idempotency constraints:** option refreshes and deferred close commits cannot overwrite the user's current filter draft.
- **Source implementation:** `routes/rer-analysis-neo/components/AnalysisFilterField.tsx`.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisFilterField.spec.tsx`.

## Analysis editor refresh integrity

- **Status:** inferred characterization
- **Behavior ID:** `react-analysis-editor-refresh-integrity`
- **Affected route/component:** `RerAnalysisNeoPage`
- **User action or external event:** the user creates or edits a message/report, follows a linked-message edit, or refreshes the page.
- **Expected observable result:** create/edit completion refreshes analysis data; linked and forwarded messages use the correct edit ownership; an edit result without an inline message cannot save stale local data; manual refresh preserves the current message page.
- **Known race/idempotency constraints:** mutation completion cannot apply a stale message object after server refresh.
- **Source implementation:** `routes/rer-analysis-neo/index.tsx`.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/index.spec.tsx`.

## Analysis mutation feedback

- **Status:** inferred characterization
- **Behavior ID:** `react-analysis-mutation-feedback`
- **Affected route/component:** `RerAnalysisNeoPage` message and report editor flow.
- **User action or external event:** the user creates a message or report, deletes a report, or cancels the editor.
- **Expected observable result:** successful message creation shows the established success notification and refreshes Analysis. Successful report creation and deletion show their corresponding success notifications and refresh Analysis. Cancelling the editor neither shows a success notification nor triggers a mutation refresh.
- **Known race/idempotency constraints:** only a completed server mutation may trigger its feedback and refresh.
- **Source implementation:** `routes/rer-analysis-neo/index.tsx`.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.

## Analysis editor and right-panel exclusivity

- **Status:** normative
- **Behavior ID:** `react-analysis-editor-right-panel-exclusivity`
- **Affected route/component:** Analysis workspace, analytics panel, filters, messages pane, and shared message editor.
- **User action or external event:** the user opens a create/edit intent, toggles Analytics, toggles filters, or closes the editor.
- **Expected observable result:** the embedded editor and Analytics are mutually exclusive and only the active right-side surface is mounted. Opening an editor closes Analytics; opening Analytics closes a clean editor or uses the existing discard confirmation for a dirty editor. Cancelling discard leaves the editor open and Analytics closed. The Analysis editor surface is flush with the center workspace divider, transparent, and borderless, so its horizontal separators meet the single shared vertical boundary. Its compact title aligns with the center tabs, while its lower divider aligns with the top edge of the message feed. Its create FAB is absent while any create/edit intent is open. Opening a generic create intent preserves the active center tab; opening an edit or report intent from a message activates Messages and highlights the source without forcing a feed scroll.
- **Loading/empty/error/success behavior:** editor/report loading and mutation feedback follow the shared editor contract. Replacing a dirty editor with Analytics does not change either surface until discard is confirmed.
- **URL, localStorage, or user-settings persistence:** opening an editor closes the URL-owned right-panel state; opening Analytics after editor dismissal restores the existing right-panel query ownership. Existing Analysis center and filter ownership remains unchanged.
- **API endpoint and compatibility requirements:** existing Analysis and message/report request contracts remain unchanged.
- **Responsive and keyboard requirements:** the embedded editor uses the same fluid right grid track as Analytics. With filters closed, the center and editor split the workspace into equal `1fr` tracks; with inline filters open, the layout is `400px 1fr 1fr`. Filters remain inline beside an embedded editor only at widths `>=1600px` and only when at least `360px` remains for the center workspace; below that threshold, filters use the existing drawer. The editor form responds to its measured width: below `560px` it uses one main column and stacks paired controls; from `560px` it keeps one main column while paired controls use two columns; from `720px` it uses two main columns while keeping compact nested sections stacked; from `900px` nested paired controls may also use two columns. Coordinate values and their preview stay side by side in equal-size panels. MGRS remains fully visible on one line; narrow panels collapse copy/delete into an actions menu, while wide panels retain the separate buttons. Below the shared editor breakpoint, the editor uses its full-screen modal surface and suppresses the filter and Analytics drawers, so the editor remains the topmost modal. The mounted right-side surface exclusively owns its keyboard interaction.
- **Known race/idempotency constraints:** a pending dirty-editor confirmation cannot open Analytics early, discard the draft without confirmation, or let a late source highlight move the reader's scroll position.
- **Source implementation:** `routes/rer-analysis-neo/AnalysisPageLayout.tsx`, `routes/rer-analysis-neo/AnalysisRightDock.tsx`, `routes/rer-analysis-neo/analysis-editor-layout.ts`, `routes/rer-analysis-neo/components/AnalysisMessagesPane.tsx`.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/index.spec.tsx`, `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/AnalysisRightDock.spec.tsx`, `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/analysis-editor-layout.spec.ts`, `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisMessagesPane.spec.tsx`.
- **Original Echo issue/PR, if known:** [#3547](https://github.com/echoua/echo/issues/3547)

## Analysis direct-link failure presentation

- **Status:** inferred characterization
- **Behavior ID:** `react-analysis-direct-link-failure-presentation`
- **Affected route/component:** `RerAnalysisNeoPage` direct-message link handling.
- **User action or external event:** a direct-linked message cannot be resolved.
- **Expected observable result:** the standard error notification reports the unavailable message once; ordinary rerenders do not repeat it or duplicate it as an inline alert.
- **Known race/idempotency constraints:** the same unresolved direct-link failure remains deduplicated across ordinary rerenders.
- **Source implementation:** `routes/rer-analysis-neo/index.tsx`.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.

## Analysis workspace interaction integrity

- **Status:** inferred characterization
- **Behavior ID:** `react-analysis-workspace-interaction-integrity`
- **Affected route/component:** RER Analysis header, filters, center panes, sidebar, pagination, report dialog, map, and summary panels.
- **User action or external event:** the user changes a filter, opens a pane/dialog, follows pagination, changes a report, or switches between analysis views.
- **Expected observable result:** controls remain available in their active layout; narrow panels use drawers without replacing the active center content; create actions remain available outside map-only states; selected filters and result navigation act on the intended data; messages, map, callsigns, frequencies, and summary views retain their distinct interaction affordances.
- **Loading/empty/error/success behavior:** loading and empty states do not expose stale actions; failed report/filter work remains retryable.
- **URL, localStorage, or user-settings persistence:** route-owned analysis state remains the source of truth.
- **Known race/idempotency constraints:** panel refreshes and pagination must not apply actions to a stale selection.
- **Source implementation:** `routes/rer-analysis-neo/index.tsx` and `routes/rer-analysis-neo/components/`.
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisMessagesPane.spec.tsx`, `wdintel-web/src/ts/react/routes/rer-analysis-neo/components/__tests__/AnalysisFiltersPanel.spec.tsx`, `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/index.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as user-visible operational safeguards.

## Analysis filter-panel presentation and error states

- **Status:** inferred characterization
- **Behavior ID:** `react-analysis-filter-panel-presentation`
- **Affected route/component:** RER Analysis filter panel and route-level error presentation.
- **User action or external event:** the user opens analysis, changes filter modes, restores a saved filter, resets active criteria, or a supporting request fails.
- **Expected observable result:** filter sections begin collapsed in their established order, expose their own counts, and show the loaded saved filter above the primary section. Saved-filter creation follows whether the current query can be reset. Metadata and tag mode controls update the corresponding query mode, while ordinary checkbox and switch changes update only their owned criteria. On narrow layouts, the filter panel begins folded until opened by the user. Server-backed filter controls remain usable during a background reload. Reset remains available during initial loading when active criteria exist and is otherwise disabled when the query matches its reset state. System-settings, callsign-graph, and direct-link request failures are exposed through the page error state.
- **Loading/empty/error/success behavior:** loading facets retain their controls and placeholders without presenting stale values as current; route-level supporting-request failures remain visible.
- **URL, localStorage, or user-settings persistence:** route-owned query and panel state remain the source of truth.
- **API endpoint and compatibility requirements:** none beyond the established analysis filter and settings responses.
- **Responsive and keyboard requirements:** the narrow filter panel starts folded without removing access to its controls.
- **Known race/idempotency constraints:** a background reload cannot disable active server-backed controls or remove reset while active criteria remain.
- **Source implementation:** `routes/rer-analysis-neo/components/AnalysisFiltersPanel.tsx` and `routes/rer-analysis-neo/use-rer-analysis-neo-page.ts`.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.
