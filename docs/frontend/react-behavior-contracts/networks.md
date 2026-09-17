# Networks

## Network API compatibility

- **Status:** operational compatibility

- **Behavior ID:** `react-networks-api-compatibility`
- **Affected route/component:** network list, frequency editor, callsign relations, activity views, and report downloads
- **User role or permission:** users authorized for the network data and mutations
- **Preconditions:** a network list, report, activity, callsign, relation, or frequency mutation is requested
- **User action or external event:** the user filters, downloads, pages activity, opens callsign relations, or changes a frequency
- **Expected observable result:** wire requests preserve supported snake-case filters and optional values; response maps normalize numeric IDs, nested frequency payloads, callsigns, and activity data for React consumers.
- **Loading/empty/error/success behavior:** optional callsign/AOR activity can be omitted intentionally; an empty text filter avoids the server default cap.
- **URL, localStorage, or user-settings persistence:** route-owned filters and table state are outside this API boundary.
- **API endpoint and compatibility requirements:** classic and Neo report payloads remain aligned; task-result bytes are downloaded by task ID; frequency mutations use established Neo endpoints.
- **Responsive and keyboard requirements:** none at the API boundary.
- **Known race/idempotency constraints:** caller-owned abort signals are forwarded to relation-message requests.
- **Source implementation:** `src/ts/react/services/api/networks.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/services/api/__tests__/networks.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational compatibility coverage.

## Network route state normalization

- **Status:** inferred characterization

- **Behavior ID:** `react-networks-route-state-normalization`
- **Affected route/component:** RER Networks filter, report, status, and activity helper boundary
- **User role or permission:** users allowed to inspect RER network data
- **Preconditions:** a network filter, saved table state, report request, or activity response is available
- **User action or external event:** the user filters/sorts networks, restores table state, opens a frequency group, or renders activity bars
- **Expected observable result:** AOR and hierarchy filters preserve classic-compatible request semantics; unsupported restored column filters are removed; status/labels/colors derive from one canonical state; frequency grouping and activity bars retain correct active/inactive and date-range meaning.
- **Loading/empty/error/success behavior:** absent/invalid filters resolve to supported default behavior rather than malformed requests.
- **URL, localStorage, or user-settings persistence:** restored table filters are normalized before use.
- **API endpoint and compatibility requirements:** request fields map to the established backend flags, sorting variants, and unpaged report/count semantics; network-details dates accept `YYYY-MM-DD`, with UTC inclusive starts, UTC next-day exclusive ends, and relations dates interpreted in the application timezone.
- **Responsive and keyboard requirements:** none at the helper boundary.
- **Known race/idempotency constraints:** stale restored column state cannot introduce unknown filter identifiers.
- **Source implementation:** `routes/rer-networks-neo/helpers.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-networks-neo/__tests__/use-rer-networks-neo-page.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as operational parser coverage.

## Network activity pagination and state

- **Status:** issue-backed regression

- **Behavior ID:** react-networks-activity-pagination-state
- **Affected route/component:** RER Networks Neo activity column and paginated network loader
- **User role or permission:** users allowed to inspect RER network data
- **Preconditions:** a network page has activity requests in flight, including a pagination or filter transition
- **User action or external event:** the user loads another page, changes the list query, or the activity API succeeds or fails
- **Expected observable result:** activity from the active query settles the matching rows; pagination does not cancel earlier pages; replaced-query activity cannot overwrite current rows; loading, inactive, and failed activity states remain distinct.
- **Loading/empty/error/success behavior:** loading has no activity bars or inactivity label; a transport failure shows the activity error rather than a false inactive state; successful zero activity remains inactive.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** activity continues to use the established network-group activity request and query-generation cancellation boundary.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** an earlier query response must not settle the replacement query, while concurrent pagination activity remains independently settleable.
- **Source implementation:** routes/rer-networks-neo/use-rer-networks-neo-page.load.ts and routes/rer-networks-neo/components/NetworkCells.tsx
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-networks-neo/__tests__/use-rer-networks-neo-page.spec.tsx`
- **Original Echo issue/PR, if known:** [#3329](https://github.com/echoua/echo/issues/3329).

## Network details workspace interaction integrity

- **Status:** inferred characterization
- **Behavior ID:** `react-network-details-workspace-interaction-integrity`
- **Affected route/component:** Network Details Neo tabs, drawers, callsign relations, frequency panels, activity, and map panels.
- **User action or external event:** the user changes a tab, edits network/frequency details, opens relation/report dialogs, or follows activity and map controls.
- **Expected observable result:** actions stay associated with the selected network, frequency, callsign, and tab; drawers preserve their intended edit/create behavior; detail, graph, table, map, and activity panels retain their visible controls and error states. When a frequency selection has not been customized, the graph selects the available default frequencies; a customized selection remains until none of it is available, at which point defaults are restored. If the response omits its frequency list, available frequencies come from edge buckets; edges without buckets retain their total weight. Active frequency and minimum-intensity filters determine visible relations, and graphs already within the render limits remain at the minimum intensity. Search is case-insensitive and keeps matching nodes and their visible neighbors highlighted. Fallback series colors remain stable and distinct beyond the base palette, and pointer zoom keeps the point under the cursor stable after SVG letterboxing.
- **Known race/idempotency constraints:** route/tab changes and refreshes cannot apply a prior entity’s action to the current network.
- **Source implementation:** `routes/rer-network-details-neo/`.
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded; retained as user-visible operational safeguards.
