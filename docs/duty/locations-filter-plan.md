# Duty: "Локації" filter (include / exclude) — dev plan

Add a "Локації" section to the RerDutyNeo feed filter panel with the same
"лише / окрім" toggle as the other Duty sections, reusing the Analysis
location filtering on the backend.

- Base branch: `main` (new filter field, saved-filter shape change).
- Branch: `feat/echo-3308-duty-location-filter`.
- Issue: [#3308](https://github.com/echoua/echo/issues/3308).

## Current state

- Analysis (`rer-analysis-neo`) supports include-only location filtering:
  - UI: `analysis-filters-panel-sections.tsx` (`FilterSection` "Локації" +
    "Включати пеленг-локації" checkbox, radio features only).
  - Options: `fetchAnalysisLocations` →
    `POST /api/rer/analysis/stats/locations` (`ensure_base_role` only, so Duty
    users can call it). Labels sorted with `<Не вказано>` first in
    `analysis-filters-panel-derived.ts`.
  - Backend: `filter_selected_locations` (`analysis/mod.rs`) — `location_v2`
    substring match, optional `freq IN (freq_location …)` for peleng
    locations, `location_v2 IS NULL` for the empty location.
- Duty feed request (`InboxMessagesReq`) already has `selected_locations` and
  `include_peleng_locations`, and `inbox/query.rs` already calls
  `filter_selected_locations`. `buildInboxReq` (`rer-duty-neo/utils.ts`)
  hardcodes both to `null`.
- No `denied_locations` exists anywhere.
- `RerDutyQueryStateWf` (saved filters, short states, local persistence) has no
  location fields.

## Time semantics

- Locations are a per-message attribute: `sigint_inbox_item.location_v2`,
  pipe-delimited uppercase settlements (`|A|B|`). The filter is a substring
  match on `|X|`; `NULL` = `<Не вказано>`. It applies to whatever window or
  cursor the feed already fetches — there is no separate time binding.
- Option list is time-bound: the stats endpoint counts messages in
  `[since, till)` by `signal_message.created_at` (`MessageCreation` basis) or
  `sigint_inbox_item.datetime` (default), splits `location_v2` into
  settlements, and may read the Redis aggregates for long ranges. Settlements
  not seen in the window are not offered.
- `location_v2` is mutable after arrival: set from text at import, extended by
  the location worker after peleng resolution, by the AI settlement worker,
  and by manual edits. Duty tail polling only fetches ids above the cursor and
  never re-evaluates loaded messages, so:
  - "лише X": a message that gets X later is missed until reload;
  - "окрім X": a message that gets X later stays visible.
  Accepted limitation (re-evaluation would hit the hot path); explain it in the
  section tooltip.
- Peleng expansion is time-agnostic: `freq_location` keeps one row per
  (freq, location) with `datetime` = last seen, and the filter ignores both
  `datetime` and `deleted`. "Включати пеленг-локації" therefore matches all
  traffic on any frequency ever linked to the location. Duty default: **off**.

## Backend (`wdintel-rs`)

### 1. Request / state types — `rer_importer/types.rs`

- `InboxMessagesReq`: add `#[serde(default)] pub denied_locations:
  Option<Vec<String>>` (struct derives `Default`, so other constructors are
  unaffected; fix any explicit literals the compiler reports).
- `RerDutyQueryStateWf`: add, all `#[serde(default)]`:
  - `locations_selected: Option<Vec<String>>`
  - `locations_denied: Option<Vec<String>>`
  - `include_peleng_locations: Option<bool>`
- Saved filters / short states store this struct as JSON, so no DB migration is
  expected. Verify the storage columns before skipping the migration.

### 2. Shared location expression — `rer_importer/analysis/mod.rs`

- Extract the expression building from `filter_selected_locations` into
  `fn locations_match_expr(locations: &[String], include_peleng_locations:
  bool) -> Option<SimpleExpr>`. Keep `filter_selected_locations` behaviour
  byte-for-byte identical (it is used by analysis, stats, reports, geojson,
  callsigns).
- Add `pub fn filter_denied_locations<Q: QueryFilter>(q, denied_locations,
  include_peleng_locations) -> anyhow::Result<Q>`.
  - **NULL pitfall:** `NOT (location_v2 LIKE '%x%')` drops rows where
    `location_v2 IS NULL`, and `freq NOT IN (subquery)` drops rows with a NULL
    `freq`. Build the exclusion explicitly:
    - each non-empty location: `location_v2 IS NULL OR NOT location_v2 LIKE …`
    - peleng part: `freq IS NULL OR freq NOT IN (subquery)`
    - empty location (`location_is_empty`) in the denied list:
      `location_v2 IS NOT NULL`
    - combine with `AND`.
  - Use `.c(h!())?` style.

### 3. Inbox query — `rer_importer/inbox/query.rs`

- Call `filter_denied_locations(q, &req.denied_locations,
  include_peleng_locations)` right after the existing
  `filter_selected_locations` call (~line 747).
- Check other inbox paths that build their own filter chain from
  `InboxMessagesReq` (map, digest, count, tail polling, notifications) and apply
  the denied filter wherever `filter_selected_locations` is already applied.
- `location_v2` has no index. Run `EXPLAIN ANALYZE` on a typical Duty feed page
  with 1–3 selected and denied locations against the test dump. If it regresses,
  raise it before adding an index (trigram index would need a migration).

### 4. Tests — `rer_importer/analysis/tests.rs` (or inbox tests)

- Existing selected-location tests (~line 3093) still pass unchanged.
- New: denied location excludes matching messages, keeps messages with
  `location_v2 IS NULL`; denied `<Не вказано>` excludes NULL-location messages;
  denied + peleng excludes `freq_location` matches and keeps NULL-freq rows;
  selected + denied combined.

### 5. Codegen and checks

- `just gen-front`, `cargo check`, `cargo clippy`, `cargo fmt`.

## Frontend (`wdintel-web`)

### 6. Request serialization

- `services/api/inbox-messages.ts`: add
  `denied_locations: emptyArrToNull(req.deniedLocations)`.
- Fix TS compile errors from new `InboxMessagesReq.deniedLocations` in other
  builders (`analysis-neo/helpers.ts`, `inbox-reference-data.ts`,
  `admin-directions-neo/GroupCardView.tsx`) with `deniedLocations: null`.

### 7. Duty filter state — `routes/rer-duty-neo/utils.ts`

- `emptyFilter`: `locationsSelected: null`, `locationsDenied: null`,
  `includePelengLocations: null`.
- `hasActiveFeedFilter`: include both location lists.
- `filtersEqual`: compare both lists and `includePelengLocations`.
- `buildInboxReq`: `selectedLocations`, `deniedLocations`,
  `includePelengLocations` (send `null` when both lists are empty).
- `useRerDutyFeedState.ts` (~line 590): when radio features are off, force
  `includePelengLocations: false` (locations stay, peleng expansion doesn't).
- `rerDutyFeedCount.ts`: add location fields to the count signature.

### 8. Persistence and saved filters

- `src/ts/rer-duty-filter-normalizer.ts`: read `locationsSelected` /
  `locations_selected`, `locationsDenied` / `locations_denied`,
  `includePelengLocations` / `include_peleng_locations`.
- `services/api/rer-duty-saved-filters.ts` `rerDutyQueryStateWfToSnake`: add
  the three fields.
- `useFeedFilterSavedFiltersViewModel.ts`: include the fields in the dirty
  check.
- Short-state create/get uses generic camel/snake transforms; verify a
  round-trip in a test.

### 9. Location options — `useRerDutyFilterOptions.ts`

- Add `locationsList: string[]`, `locationsLoading`, `reloadLocations`.
- Duty is a live stream without a date range, so the option list uses a fixed
  look-back: `fetchAnalysisLocations` with a minimal `AnalysisStatsReq` for
  `[now - 2 days, now)` (same look-back as the group catalog), named constant
  `DUTY_LOCATIONS_LOOKBACK_MS`, all other filters `null`, `messageTimeBasis`
  aligned with Duty creation time. The look-back only limits suggestions, not
  what can be filtered.
- Load lazily when the field is opened (refetch on each open, recomputing
  `now`), not on page mount (avoid an extra stats query for every Duty load).
- Merge currently selected / denied values into the option list so saved
  filters with old locations still render as chips.
- Allow free entry (typed value + bulk paste) of settlements not present in the
  window; normalize to uppercase trimmed text to match `format_location`.
- Shared helper: move the "normalize label, sort, `<Не вказано>` first" logic
  from `analysis-filters-panel-derived.ts` into `utils/` and use it from both
  pages (no behaviour change on Analysis).
- Errors: show via the existing toast path, don't swallow.

### 10. Panel wiring

- `FeedFilterPanel.tsx` model: add `filterState.locationsSelected /
  locationsDenied / includePelengLocations`, `sources.locationsList`,
  `toggles.locationsLoading`, and actions `onLocationsChange`,
  `onLocationsDeniedChange`, `onLocationsModeTransfer`,
  `onIncludePelengLocationsChange`, `onLoadLocations`.
- `useDutyFeedColumnModel.ts`: implement those actions via `applyFilter`
  (mirror posts, ~lines 205–212).
- `useFeedFilterPanelViewModel.ts`: `useFeedFilterSelectionState<string>` for
  locations, `useDutyBulkCopy({ entityLabel: 'локації' })`, placeholder
  `всі` / `жодна`, `bulkCopyMenuLabel: 'Копіювати обрані локації'`.
- `FeedFilterPanelView.tsx`: new `FeedFilterSelectionSection title="Локації"`
  after "Пост" (before "Підрозділи"), with bulk paste (`'\n'` separator,
  "Додати кілька локацій"). Under it, the "Включати пеленг-локації" checkbox,
  rendered only when `useRadioFeatures()` is true and a location is selected
  or denied; unchecked by default (`includePelengLocations: null` → backend
  `false`). Tooltip on the section explains the late-location limitation.
- `FeedFilterSelectionSection`: add an `onOpen` passthrough (or use
  `onInputChange`) to trigger the lazy options load.
- Keep this inside the filter panel; do not touch the protected MessageCard hot
  path.

### 11. Frontend tests

- `FeedFilterPanel.spec.tsx`: section renders, mode toggle moves values,
  peleng checkbox visibility rules.
- `utils` tests: `buildInboxReq`, `filtersEqual`, `hasActiveFeedFilter`,
  `emptyFilter` include location fields.
- `rer-duty-saved-filters.spec.ts`: snake serialization + normalizer round
  trip.
- `RerDutyNeoWorkspace.spec.tsx` / regression specs: update fixtures for the new
  filter fields.
- `npm run format:staged`, `elm`-side unaffected, `just build-front`.

## Out of scope / follow-ups

- Quick "exclude this location" action from a Duty message card
  (`isMessageEntityExcluded` in `utils.ts`).
- Exclude mode for Analysis locations.
- Index on `location_v2` (only if profiling requires it).
- `filter_selected_locations` peleng subquery ignores `freq_location.deleted`
  (affects Analysis too) — separate fix.

## Rollout

- `CHANGELOG.md` `NEXT` entry with the issue reference.
- Verify on the test dump: create a feed with included and excluded locations,
  save it as a saved filter, reload page, share via short state link.
