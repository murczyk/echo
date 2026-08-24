# Maps and coordinates

## Coordinate interchange

- **Status:** operational compatibility

- **Behavior ID:** `react-map-coordinate-interchange`
- **Affected route/component:** shared map coordinate format, search, and block parser
- **User role or permission:** any user who can search or inspect a map
- **Preconditions:** a user pastes or reads WGS-84, DMS, MGRS, UTM, SK-42, or УСК-2000 coordinates
- **User action or external event:** coordinates are parsed, formatted, or round-tripped between map controls
- **Expected observable result:** supported forms resolve to finite latitude/longitude values, preserve input ordering for coordinate blocks, and render in the selected output system. Invalid mixed blocks are rejected rather than partially accepted as complete.
- **Loading/empty/error/success behavior:** failed MGRS conversion has no displayed MGRS value; unsupported coordinate content prevents a block from being fully parsed.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none; this is a client-side operational interchange format.
- **Responsive and keyboard requirements:** pasted values must be accepted without a browser-specific interaction.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `src/ts/maps/coordinate-format.ts`, `coordinate-search.ts`, `coordinate-parser.ts`
- **Existing test(s):** `coordinate-format.spec.ts`, `coordinate-search.spec.ts`, `coordinate-parser.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational parser coverage.

## Palette search grammar

- **Status:** operational compatibility

- **Behavior ID:** `react-map-palette-search-grammar`
- **Affected route/component:** shared palette search parser and matcher
- **User role or permission:** map users with palette access
- **Preconditions:** the palette search control receives a comma-separated query
- **User action or external event:** the user enters exact, prefix, suffix, or contains terms
- **Expected observable result:** commas separate normalized terms, spaces inside a term remain meaningful, and matching follows the requested exact/prefix/suffix/contains mode.
- **Loading/empty/error/success behavior:** empty or whitespace-only input yields no filters.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `src/ts/maps/palitra-search.ts`
- **Existing test(s):** `palitra-search.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational parser coverage.

## Palette access and blacklist safety

- **Status:** inferred characterization

- **Behavior ID:** `react-map-palette-access-and-blacklist-safety`
- **Affected route/component:** palette reference loader and highlight blacklist API boundary
- **User role or permission:** Rer, editor, and administrator roles with their respective palette privileges
- **Preconditions:** a palette route loads reference data or a permitted user edits a palette highlight blacklist
- **User action or external event:** reference data loads, an upload receives 401, or a blacklist entry is added/deleted
- **Expected observable result:** roles without editing authority do not request editable login references; unauthorized uploads redirect to login; blacklist mutations use the current palette and source-message identity; legacy and generated response shapes normalize consistently.
- **Loading/empty/error/success behavior:** non-auth reference errors produce null reference groups; duplicate/empty name lookup values do not create invalid palette data.
- **URL, localStorage, or user-settings persistence:** none at the API boundary.
- **API endpoint and compatibility requirements:** supported blacklist count, entry, and palette-name response forms normalize for consumers.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** an atomic blacklist mutation must not target another palette or source message.
- **Source implementation:** `src/ts/react/services/api/palitra.ts`
- **Existing test(s):** `src/ts/react/services/api/palitra.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as authorization, safeguard, and parser coverage.

## Persisted analysis-map feature state

- **Status:** inferred characterization

- **Behavior ID:** `react-analysis-map-state-migration`
- **Affected route/component:** analysis map feature-state store
- **User role or permission:** analysis-map users
- **Preconditions:** localStorage contains a persisted map state from a prior release
- **User action or external event:** the map initializes and the user changes feature visibility
- **Expected observable result:** the legacy `kmz` preference migrates to `deltaKml` without losing other feature values; subsequent changes persist the canonical feature key.
- **Loading/empty/error/success behavior:** invalid/missing persisted data falls back to safe defaults.
- **URL, localStorage, or user-settings persistence:** uses the map-state localStorage key and writes canonical state after migration.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** migration is idempotent once canonical state is written.
- **Source implementation:** `src/ts/maps/analysis-map-state.ts`
- **Existing test(s):** `analysis-map-state.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as persisted-state parser coverage.

## RER Palette access and flat-folder safety

- **Status:** inferred characterization

- **Behavior ID:** `react-rer-palette-access-and-folder-safety`
- **Affected route/component:** RER Palette form, bulk actions, and flat folder table helpers
- **User role or permission:** palette administrators, RER editors, authors, and read-only users
- **Preconditions:** the user opens a palette form, selects palette rows, or performs a folder action
- **User action or external event:** access restrictions are normalized, a folder is selected, or a bulk action is constructed
- **Expected observable result:** only authorized roles/authors can modify palettes; non-admin forms retain only current-scope access; GOI/read-only palettes stay selectable/downloadable as permitted but cannot be mutated; flat folders reject nested paths and table rows retain canonical grouping.
- **Loading/empty/error/success behavior:** missing allowed selections fall back to the user's legal scope; invalid folder paths are rejected.
- **URL, localStorage, or user-settings persistence:** expanded folder state remains route-owned.
- **API endpoint and compatibility requirements:** access/login values normalize without losing valid selected order.
- **Responsive and keyboard requirements:** none at the helper boundary.
- **Known race/idempotency constraints:** a bulk selection must not acquire mutation permission from a stale row/access scope.
- **Source implementation:** `routes/rer-palitra-neo/helpers.ts`
- **Existing test(s):** access, permission, and flat-folder cases in `helpers.spec.ts`; isolated preview/summary formatting tests were removed.
- **Original Echo issue/PR, if known:** none recorded; retained as authorization/safety/parser coverage.

## Coordinate locality label

- **Status:** inferred characterization

- **Behavior ID:** `react-map-coordinate-locality-label`
- **Affected route/component:** map locality label formatter
- **User role or permission:** map users
- **Preconditions:** a mapped coordinate has locality metadata
- **User action or external event:** the map displays the coordinate locality
- **Expected observable result:** a point inside a settlement displays only the settlement; an external point displays rounded Ukrainian distance, direction, and settlement.
- **Loading/empty/error/success behavior:** absent locality remains absent rather than inventing a location.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** locality data is normalized by the shared location API boundary.
- **Responsive and keyboard requirements:** none.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `src/ts/maps/coordinate-locality.ts`
- **Existing test(s):** previously `coordinate-locality.spec.ts`; removed as a trivial formatting-only assertion.
- **Original Echo issue/PR, if known:** none recorded.
