# MRT table contracts

See [the frontend MRT skill](../../../.github/skills/frontend-mrt-tables/SKILL.md) for shared implementation rules.

## Internal columns and persisted state

- **Status:** normative

**Behavior ID:** `mrt-internal-column-order`

- **Affected component:** `TableStateProvider` and route MRT configurations.
- **User role or permission:** any user who can access the table route.
- **Preconditions:** the table has current internal columns and optional persisted local-storage state.
- **User action or external event:** the user changes a table setting or the application restores stale saved state.
- **Expected observable result:** selection, row number, and action columns retain their shared leading order; stale local-storage column order is normalized when column identities change.
- **Loading/empty/error/success behavior:** tables remain usable when no saved state exists or stale state is discarded.
- **Persistence:** filter/sorting URL state preserves unrelated parameters; visibility/order/sizing remains local-storage-backed.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** internal controls retain MRT's keyboard-accessible behavior.
- **Known race/idempotency constraints:** normalization must not repeatedly rewrite already canonical saved state.
- **Source implementation:** `wdintel-web/src/ts/react/components/mui-customized/table/`.
- **Existing test(s):** focused MRT state/overflow coverage is being classified under the admission migration.
- **Original Echo issue/PR, if known:** none recorded.

## Row-action overflow

- **Status:** normative

**Behavior ID:** `mrt-row-action-overflow`

- **Expected observable result:** row actions preserve labels, icons, disabled state, and destructive ordering; menu actions release focus before opening modal surfaces.
- **Loading/empty/error/success behavior:** unavailable actions remain disabled rather than disappearing unexpectedly.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** trigger/menu remain screen-reader labelled and keyboard operable.
- **Known race/idempotency constraints:** opening a modal action must not leave focus trapped in a closing overflow menu.
- **Source implementation:** `MrtRowActionButton.tsx` and route action columns.
- **Existing test(s):** MrtRowActionButton.spec.tsx protects modal-focus and disabled destructive-action safeguards; browser MRT overflow coverage protects disclosure behavior.
- **Original Echo issue/PR, if known:** none recorded.

## Table frame layout

- **Status:** normative
- **Behavior ID:** `mrt-table-frame-layout`
- **Affected component:** shared MRT paper and container defaults.
- **User role or permission:** any user viewing a table.
- **Preconditions:** a route selects either list or workspace table framing.
- **User action or external event:** table data loads, empties, or opens in the workspace frame.
- **Expected observable result:** list tables keep their bounded page frame; empty lists avoid a redundant vertical scroll region; workspace tables fill and scroll within their owning pane.
- **Loading/empty/error/success behavior:** loading and empty table frame sizing remains owned by the route's shared MRT props.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** scroll ownership stays with the visible table frame.
- **Known race/idempotency constraints:** none.
- **Source implementation:** `custom-styles.ts`
- **Existing test(s):** verified through route-level table interaction coverage; isolated style-object assertions were removed.
- **Original Echo issue/PR, if known:** none recorded.

## Active-filter summary

- **Status:** normative
- **Behavior ID:** `mrt-active-filter-summary`
- **Affected component:** MRT active-filter summary control.
- **User role or permission:** any user filtering a table.
- **Preconditions:** one or more table or global filters are active.
- **User action or external event:** the user opens the active-filter control or clears a listed filter.
- **Expected observable result:** the control reflects live MRT state, omits a column's configured default filter, and clears the selected live filter without changing unrelated filters.
- **Loading/empty/error/success behavior:** no summary appears when there are no non-default active filters.
- **URL, localStorage, or user-settings persistence:** route table state owns persistence.
- **API endpoint and compatibility requirements:** none.
- **Responsive and keyboard requirements:** filter controls remain accessible through their existing menu semantics.
- **Known race/idempotency constraints:** a stale prop snapshot cannot override current MRT filter state.
- **Source implementation:** `active-filters-button.tsx`, `active-filters-utils.ts`
- **Existing test(s):** `active-filters-button.spec.tsx`; isolated helper-formatting coverage was removed.
- **Original Echo issue/PR, if known:** none recorded.
