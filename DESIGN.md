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

Keep side navigation flat, as on the current Analysis page: inherit the workspace
background by default and separate columns or sections with simple dividers.
An explicitly approved layout may share the header surface across navigation
columns. Avoid card wrappers, rounded outer borders, shadows and individual panel
backgrounds unless the content needs a distinct surface. Use list items for navigation destinations.

## Motion and state continuity

Smoothness and usability are acceptance criteria for new or changed interactions,
not optional polish after functionality passes. Apply the following gate to the
affected flow; it does not authorize unrelated redesign or decorative motion.

- **Purpose and consistency:** movement explains a state, spatial relationship
  or continuity. Reuse the existing component's motion, duration and easing;
  introduce a new pattern only for an approved need. Routine repeated actions
  get immediate static feedback or a restrained transition, not staged entrances,
  bounce, overshoot or attention-seeking effects.
- **Immediate response:** show selection, pressed state or relevant loading feedback
  as soon as an action is accepted. Never hold input, navigation or completed data
  for an animation to finish. Avoid transient spinner/skeleton flashes without
  delaying available results; animation must not conceal a slow operation.
- **Stable geometry:** preserve the reader's visual anchor and scroll position.
  Loading, empty and error indicators must not shift unrelated content; skeletons
  reuse the loaded content's outer spacing and width. Do not reset scroll to make
  a transition easier. Keep header and body inside one coordinated resizing owner.
- **Coherent lifecycle:** inspect the first, intermediate and final frames of
  opening and closing. No flashing, detached headers, overflowing exit content,
  incorrect stacking, end-of-transition snap or content disappearing over the
  next surface. Clip or remove exiting content in coordination with geometry.
  Hidden/exiting controls must not intercept pointer or keyboard focus.
- **Interruptibility:** rapid toggle, reversal, another selection, resize and
  cancellation converge on the latest intent from the current visual state.
  Do not queue old transitions, jump back to an initial frame or let stale timers,
  animation callbacks or network responses restore an obsolete state.
- **Accessible operation:** preserve keyboard access, visible focus, logical focus
  return and readable static feedback. Honor `prefers-reduced-motion`: remove
  nonessential movement and animated scrolling while retaining the state change.
  Animation is never the only indication of selection, progress or success.
- **Rendering cost:** prefer `transform`/`opacity` for effects that do not need to
  change layout. When actual panel/column resizing is required, coordinate the
  real layout, limit its scope and inspect its cost; a transform must not fake
  geometry while hit areas, text or scroll layout remain wrong. Specify transition
  properties; do not introduce `transition: all`, per-frame React state updates
  across message trees or blanket `will-change` as a polish shortcut.
- **Observed quality:** dev and QA each inspect affected interactions in the
  browser at CPU slowdown 4x, with normal and reduced motion, rapid reversal and
  relevant drawer/mobile/resize states. A final screenshot or green unit test does
  not verify a transition. Investigate visible stalls with browser performance
  tools when needed; report measured evidence rather than asserting universal
  frame-rate or timing guarantees.

Known flashing, displaced content, lost reading position, blocked input or broken
focus in the changed flow fails this gate and must be fixed before claiming that
flow complete. Missing execution remains unverified. Keep the checks proportional
to the actual motion change; do not repeat unrelated suites or every device/theme
combination for a local repair.

Accessibility reference: [W3C animation from interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions).
Rendering reference: [web.dev animation performance guidance](https://web.dev/articles/animations-guide).
These inform this project gate; they do not establish application-wide WCAG
conformance or a measured performance budget. The
[Duty search contract](docs/frontend/react-behavior-contracts/duty.md#independent-duty-search)
owns the search-specific layout and state rules.

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
- Keep only descriptive metadata in this file's frontmatter. Read token values from the canonical manifest rather than duplicating them in design-tool configuration.
