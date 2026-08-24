---
name: frontend-mrt-tables
description: Update Material React Table usage in wdintel-web, including shared TableStateProvider URL/localStorage behavior, selection-column behavior, row-actions overflow rules, shared menu wiring, and MRT-specific regression checks.
---

# Frontend MRT Tables

## Short description (for triggering)
Use when editing `material-react-table` usage in `wdintel-web/src/ts/react`, especially shared table helpers, selection columns, row actions, or MRT display-column behavior.

## When to use / When NOT to use
- Use: MRT table options, shared `MrtRowActionButton`, selection-column behavior, action-column layout, shared menu integration.
- Use: Files such as `MrtRowActionButton.tsx`, `mui-customized/table/*`, and React route tables using `useMaterialReactTable`.
- Do not use: Elm-only tables or non-MRT UI.
- Do not use: Generic React work unrelated to `material-react-table`.

## Inputs to derive
- Derive whether the table uses shared defaults from `getDefaultMRTOptions`.
- Derive whether the route uses shared row actions from `MrtRowActions` / `MrtRowActionButton`.
- Derive whether permissions should disable interaction or hide controls entirely.

## Procedure (checklist)
- Prefer fixing MRT behavior in shared helpers before patching individual routes.
- Start from shared helpers:
- `getDefaultMRTOptions`
- `buildDefaultColumnOrder`
- `TableStateProvider`
- `MrtRowActions` / `MrtRowActionButton`
- Shared defaults currently assume:
- sticky header
- grid layout
- MRT top/bottom toolbars disabled by default
- row virtualization enabled by default
- Table layout/order should follow shared column-order helpers:
- if enabled, selection stays first
- row numbers stay after selection
- actions stay before data columns
- use `buildDefaultColumnOrder` instead of hand-assembling ad hoc orders
- Keep permission-gated selection columns visible:
- Do not turn off `enableMultiRowSelection` or `enableSelectAll` just because the user lacks edit rights.
- Gate interaction through `enableRowSelection` and shared checkbox props so select-all and row checkboxes stay visible but disabled.
- Shared state rules:
- `globalFilter`, `columnFilters`, and `sorting` belong in URL search params when the route uses `TableStateProvider`
- `date` belongs in URL search params only when it differs from the route default date
- column visibility, column order, column sizing, and column ordering/resizing toggles belong in local storage via `tableId`
- table state must rehydrate from URL on first render and react to `popstate`
- hidden columns should also remove their column filters through `onChangeColumnsVisibility`
- preserve existing unrelated search params when updating MRT params
- Keep row actions consistent through shared action components:
- `1` or `2` actions: render inline as-is.
- `3+` actions: keep the first action visible and move the rest behind the vertical `MoreVert` menu.
- Apply the `1+` overflow rule globally, including tables that previously used `layout="grid"`.
- This repo already implements `1+ menu`; do not reintroduce the older `2 + Menu` rule.
- Preserve action metadata in overflow items:
- icon stays the current icon
- text comes from the current action `label`
- disabled and danger styling stay intact
- destructive actions should stay last in the overflow list whenever the route controls ordering that way
- Keep overflow menu accessibility correct:
- pass trigger-driven `aria-labelledby`
- do not let the shared `Menu` wrapper clobber caller-provided `MenuListProps`
- When changing overflow behavior, update `mrtRowActionsColumnSize` so the actions column width matches the rendered layout.
- Prefer standard MUI menu spacing unless a route has a proven visual requirement.
- Column-order rules:
- always pass a stable `defaultColumnOrder`
- run stored order through `normalizeColumnOrder`
- internal MRT columns stay first in the shared order
- invalid/stale stored orders are rewritten to the normalized order
- if row numbers are hideable, verify the default order still places data/action columns correctly with row numbers hidden and shown
- Per-route settings should use shared table props/provider inputs instead of ad hoc localStorage keys.

## Definition of Done (checklist)
- Shared MRT behavior matches the intended global rule, not just one route.
- Shared helpers still match repo defaults instead of drifting per route.
- Selection-column permission behavior stays visible and disabled rather than disappearing or switching to radios unintentionally.
- `3+` row actions use the shared `1+ menu` pattern.
- URL-backed filters/sorting/global search stay shareable and back-button aware.
- Local-storage-backed column layout survives reload and tolerates added/removed columns.
- Overflow menu remains keyboard and screen-reader friendly.
- Relevant tests and build checks pass.

## Targeted checks
- `cd wdintel-web && npm run test:ts:scope-check`
- Run only admitted parser, safeguard, or linked regression coverage affected by the change.
- Manually verify internal-column order, stale local-storage normalization, and overflow disclosure when no faithful admitted boundary exists.
- `just build-front`

## Assumptions
- MRT tables in this repo should converge on shared behavior rather than per-route one-off implementations.
