# Analysis

## Analysis API compatibility

- **Status:** operational compatibility

- **Behavior ID:** `react-analysis-api-compatibility`
- **Affected route/component:** analysis search, callsign information, message retrieval, and direct submission boundaries
- **User role or permission:** users authorized to inspect or mutate the current analysis data
- **Preconditions:** analysis criteria or message IDs are submitted
- **User action or external event:** the user searches callsign frequencies, loads messages, submits a message, or records a model/tag action origin
- **Expected observable result:** normalized analysis criteria and ContentNode variants survive the wire boundary; sender statistics use returned profile names and network statistics hydrate missing unit names for user-facing filter labels; highlight context and optional action origins are preserved without altering the business request body.
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
- **Expected observable result:** date-only differences do not mark a saved filter dirty, non-date differences do, `onlyWithMedia` affects UI dirty state but not saved-filter equality, initial `unitsExactMatchOnly` is null, defaults span today through tomorrow in the application timezone, direct links extend the interception or creation range as applicable and do not fall back when creation time is unavailable, saved filters reset adjacent-frequency expansion, and only `showMap=true` enables the map.
- **Loading/empty/error/success behavior:** unavailable creation time leaves the current direct-link range unchanged.
- **URL, localStorage, or user-settings persistence:** URL `showMap` is accepted only for the literal value `true`; saved-filter equality intentionally excludes `onlyWithMedia`.
- **API endpoint and compatibility requirements:** initial null unit matching preserves the backend default.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** applying a saved filter clears stale adjacent-frequency expansion.
- **Source implementation:** `routes/rer-analysis-neo/helpers.ts`.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.

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
- **Expected observable result:** initial loads include required filter facets and selected lazy facets; later loads reuse loaded or targeted facets. An opened lazy section shows loading rather than a false empty state. Filter labels retain returned statistics and hydrated network/unit names; duplicate group labels merge without losing selected master keys, callsign labels are displayed in uppercase without changing submitted values, and networks use their statistics labels and ordering. The device filter appears only when Cyber Echo is enabled, while frequency bulk input accepts comma and newline separators. While facets are loading, counters use an em dash; once loaded, they show section-specific selected and total counts. Exact-match controls appear only for applicable selected values, reflect an explicit query value or the loaded default, and map their checked state to the corresponding query mode without changing while counts load. Disabling peleng also clears the dependent without-coordinates option. Map message IDs are filtered before fetches, and messages absent from a map response are not rendered as map points. A backend page shorter than its supplied limit ends pagination; no exhaustion is inferred when that limit is absent.
- **Known race/idempotency constraints:** invalidated or stale filter and map responses cannot replace current state.
- **Source implementation:** `routes/rer-analysis-neo/use-analysis-data-filter-sections.ts`, `use-analysis-data.loaders.ts`, and `use-analysis-data.shared.ts`.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.

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

## Analysis workspace interaction integrity

- **Status:** inferred characterization
- **Behavior ID:** `react-analysis-workspace-interaction-integrity`
- **Affected route/component:** RER Analysis header, filters, center panes, sidebar, pagination, report dialog, map, and summary panels.
- **User action or external event:** the user changes a filter, opens a pane/dialog, follows pagination, changes a report, or switches between analysis views.
- **Expected observable result:** controls remain available in their active layout; selected filters and result navigation act on the intended data; messages, map, callsigns, frequencies, and summary views retain their distinct interaction affordances.
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
