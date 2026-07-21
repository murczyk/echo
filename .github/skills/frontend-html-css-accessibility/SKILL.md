---
name: frontend-html-css-accessibility
description: Apply HTML/CSS updates with accessibility-first behavior, responsive checks, and repo-consistent styling primitives (MUI sx, utility classes, CSS vars).
---

# Frontend HTML/CSS Accessibility

## Short description (for triggering)
Use when changing markup, classes, layout, spacing, colors, or interaction states in Elm or React UI.

## When to use / When NOT to use
- Use: UI layout/styling work with visible behavior changes.
- Use: Navbar, forms, dialogs, tables, cards, page layouts.
- Do not use: Backend-only changes with no UI impact.
- Do not use: Commit/changelog-only work.

## Inputs the agent should request or derive
- Derive impacted pages/routes from changed files.
- Derive existing color/spacing conventions from nearby components.
- Derive interactive states (hover, focus, disabled, error, loading).
- Ask only if expected responsive behavior is not inferable.

## Procedure (checklist)
- Keep semantic structure:
- Correct element types for buttons/links/headings.
- Labels/aria for form controls and icon-only actions.
- Use filled MUI icons for actionable controls by default; use outlined variants only where an established visual or semantic convention specifically requires them.
- Preserve visible focus indicators; do not remove outlines without replacement.
- Keep contrast and readability aligned with existing theme variables:
- Prefer MUI palette tokens, theme CSS vars, or existing design-system tokens for all light/dark UI work.
- Avoid raw `rgba(...)`, hard-coded dark/light hex values, and mode-only color branches unless no token-based option exists.
- If translucency is needed, prefer `color-mix(...)` with CSS vars or an existing theme token before falling back to raw alpha values.
- Reuse existing styling system in that file:
- Elm/Tailwind utility classes when already present.
- MUI `sx`/components in React files.
- In the protected Duty/MessageCard hot path, preserve MUI theme parity through semantic HTML, existing utilities, shared theme-backed CSS variables, and leaf MUI components. Do not introduce structural MUI wrappers solely to obtain theme styling.
- Prefer minimal, local style changes over global overrides.
- Validate responsive layout at common widths:
- Mobile (~360px)
- Tablet (~768px)
- Desktop (~1280px)
- Validate UX states:
- loading
- empty
- error
- success/normal
- Run build:
- `just build-front`

## Definition of Done (checklist)
- No broken layout at mobile/tablet/desktop.
- Keyboard navigation works for added/changed controls.
- Focus states are visible and logical.
- Error/empty/loading states are still understandable.
- `just build-front` passes.

## Tiny examples
```tsx
<TextField
  label="Group name"
  error={Boolean(error)}
  helperText={error ?? " "}
/>
```

## Self-check
- Review diff for unintended global class/style impact.
- Re-check core flows touching changed UI surfaces.
- Re-check that theme-aware styling uses tokens/CSS vars instead of hard-coded mode colors.
- Confirm no keyboard traps in menus/dialogs.
- Confirm REST-facing controls still trigger correct actions (no swapped buttons).
- Confirm repo frontend build step passes.

## Assumptions
- This repo uses mixed Elm + React surfaces; styling should follow the local context of each file.
