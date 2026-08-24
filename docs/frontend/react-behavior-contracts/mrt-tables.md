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
- **Existing test(s):** focused MRT overflow coverage is being classified under the admission migration.
- **Original Echo issue/PR, if known:** none recorded.
