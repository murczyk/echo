---
name: frontend-layout-component-separation
description: Implement or refactor React UI in wdintel-web with native semantic HTML and Tailwind for layout, MUI or Power wrappers for interactive components, and shared Echo design tokens for visual values.
---

# Frontend layout/component separation

Use this skill whenever React work adds or changes structure, layout, responsive behavior, or styling.

## Contract

Read and follow [`wdintel-web/FRONTEND_DESIGN_CONTRACT.md`](../../../wdintel-web/FRONTEND_DESIGN_CONTRACT.md). Its ownership boundary and token rules are authoritative.

## Required decisions

- Use semantic native HTML for structure.
- Use Tailwind for display, grid/flex, spacing, sizing, positioning, overflow, and responsive layout.
- Use MUI or the matching `Power*` wrapper for controls and interaction behavior.
- Do not add layout-only `Box`, `Stack`, `Grid`, `Container`, structural `sx`, or wrappers that conceal those abstractions.
- Use namespaced Echo tokens for new theme-sensitive or scale-sensitive values: `echo-*` colors, spacing, sizes, radii, type sizes, shadows, and breakpoints.
- Use `theme.echo.breakpoint` for JavaScript behavior that must match an Echo responsive variant. MUI's built-in spacing and breakpoints are legacy compatibility APIs, not new layout APIs.
- Keep `sx` only for MUI-specific slots/states, third-party `sx` boundaries, or genuinely runtime-calculated component values.
- Preserve semantic elements, keyboard behavior, focus visibility, and responsive reading order.

## Scope control

Do not migrate unrelated legacy layout. When the requested change directly touches a legacy layout region, migrate only the smallest coherent region when safe. The `duty-feed-rendering-safety` skill remains stricter for Duty and shared MessageCard hot paths.

## Token changes

Update `wdintel-web/src/design-system/tokens.json`, run `npm run tokens:generate`, and never edit `_design-tokens.generated.css` directly. Color values remain in `_variables.css`; the token manifest contains their shared references.

## Verification

- Run `cd wdintel-web && npm run format:staged` after frontend edits.
- Run focused tests for touched behavior.
- Run `just build-front`.
- Review the diff for new structural MUI wrappers, layout-only `sx`, arbitrary repeated values, and hard-coded light/dark colors.
