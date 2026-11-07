---
name: Echo web UI
description: Current design context for the main wdintel-web application, grounded in its canonical tokens and frontend contracts.
---

# Echo design context

## Overview

Scope: the main `wdintel-web` application, including Elm and React surfaces. Separate GOI and documentation applications need their own context. Read [PRODUCT.md](PRODUCT.md) for user goals and unresolved product questions.

The [frontend layout and component contract](docs/frontend/layout-component-contract.md) defines the foundation. [tokens.json](wdintel-web/src/design-system/tokens.json) is the sole manifest for shared visual values. Its generated [CSS](wdintel-web/src/styles/_design-tokens.generated.css) and [TypeScript](wdintel-web/src/design-system/design-tokens.ts) are outputs, never independent sources to edit.

This document records current decisions rather than asserting that every legacy screen conforms. When code, documentation, and a proposed rule disagree, report the exact sources and the affected surface; follow the applicable `AGENTS.md` and contracts, and resolve the conflict within the requested scope. An incidental discrepancy does not authorize a global theme migration.

## Colors

Use semantic roles from the manifest's `color.light` and `color.dark`: backgrounds/surfaces, text, borders/dividers, primary/secondary actions, status, focus, and interaction states. Pair foreground and background roles for the actual state and theme; a token's existence does not prove adequate contrast.

Legacy variables in [_variables.css](wdintel-web/src/styles/_variables.css) include compatibility aliases and legacy-only values. Reuse an appropriate existing role rather than copying a light/dark color into a component.

[`createNeoMuiTheme(mode)`](wdintel-web/src/ts/react/mui-theme.ts) exposes generated Echo data through `theme.echo`. It currently sets MUI's `palette.mode`; it does **not** activate the Echo semantic palette globally. Preserve MUI compatibility until a separately approved migration has representative light/dark visual coverage.

Known concern: muted foreground/surface combinations in the existing manifest need rendered contrast review. Record affected combinations and states as findings; do not prescribe them as accessible examples or silently change tokens during context work.

## Typography

The manifest's `typography` group owns shared font-family and size roles. Its font family follows the existing Bootstrap body-font variable with platform fallbacks. Existing MUI typography and legacy declarations in [style.css](wdintel-web/src/styles/style.css) coexist; this context does not imply that all screens already share one font treatment.

Use established semantic hierarchy and readable Ukrainian labels. Preserve existing truncation, wrapping, tooltips, and dense-card behavior where they carry information. Evaluate long text and zoom in the affected rendered surface instead of deriving accessibility from a token scale alone.

## Layout

Native semantic HTML and Tailwind own application layout. MUI and `Power*` own interactive components and their behavior. Use named `echo-*` utilities for new shared spacing, dimensions, and responsive geometry; see the [ownership boundary](docs/frontend/layout-component-contract.md#ownership-boundary).

MUI spacing and breakpoints are compatibility APIs; Echo spacing and behavioral breakpoints are separate generated roles. Do not substitute one scale for the other. JavaScript that must match an Echo responsive variant reads the generated Echo breakpoints.

Existing numeric utilities and standard breakpoints remain valid in legacy code. Do not replace layout or responsive behavior merely to make nearby code uniform. Check the affected narrow/wide layouts, overflow, loading, empty, error, and long-content states against the relevant [behavior contract](docs/frontend/react-behavior-contracts/README.md).

## Elevation & Depth

Use the manifest's `shadow` roles for shared application structure. MUI internal elevations and transitions remain component implementation details. Distinguish overlays and layered content with the existing dialog/drawer/menu behavior, including focus and Escape handling; do not add decorative depth that obscures dense information.

## Shapes

The manifest's `radius` and `size` groups define shared shape, control, and icon roles. Follow existing component geometry and interaction targets. Avoid creating a new radius/size scale inside a screen; propose a shared token only when a repeated need is established.

## Components

- [Power components](wdintel-web/src/ts/react/components/README.md): shared forms, buttons, menus, pickers, and feedback behavior. Use `PowerAlert` for contextual/persistent states and `PowerSnackbar` for transient action feedback in independently mounted React roots.
- `EchoChip`: dense repeated application chips; `PowerChip`: lower-density or behavior-rich MUI chips. They are not interchangeable defaults.
- [Duty local instructions](wdintel-web/src/ts/react/routes/rer-duty-neo/AGENTS.md) and [MessageCard local instructions](wdintel-web/src/ts/react/routes/shared/message-card/AGENTS.md) govern hot paths and rendering behavior. Duty rendering guidance remains reference-only in `.github/skills/duty-feed-rendering-safety`.
- [Behavior contracts](docs/frontend/react-behavior-contracts/README.md) own loading, empty, error, navigation, permission, and persistence details. Elm API failures follow the toast handling specified in [AGENTS.md](AGENTS.md).
- [Storybook stories](wdintel-web/src/stories/message-card/MessageCard.stories.tsx) currently demonstrate MessageCard audio states; they are not a complete component catalog or visual regression baseline.

## Do's and Don'ts

- Reuse semantic tokens, native controls, existing wrappers, and the nearest local contract.
- Preserve keyboard access, visible focus, meaningful labels, and user-visible API failures.
- Verify relevant light/dark, responsive, and content states in the browser; explicitly list unverified states when browser access is unavailable.
- Do not introduce layout-only MUI `Box`/`Stack`/`Grid`/`Container`, structural `sx`, generated `.Mui-*` selectors, copied mode colors, or clickable `div` controls. The layout contract documents permitted component-boundary exceptions.
- Do not edit generated token outputs or treat a clean token freshness check as proof of contrast or UX quality.
- Keep only descriptive metadata in this file's frontmatter. Machine token projections, design-system drift checks, and `.impeccable/design.json` are outside this first iteration; the shared Impeccable configuration disables drift checks while retaining general detector checks.
