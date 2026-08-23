# Frontend layout and component contract

## Scope

This contract establishes the frontend foundation. It does not require migration of existing `Box`, `Stack`, `Grid`, `Container`, `sx`, spacing, breakpoint, or responsive behavior.

- Native semantic HTML and Tailwind own application layout.
- MUI and `Power*` own interactive components and component-specific behavior.
- One manifest owns shared design tokens.
- Existing screens retain their appearance unless a visual change is approved separately.

## Token architecture

`wdintel-web/src/design-system/tokens.json` is the canonical manifest. `npm run tokens:generate` produces:

- `src/styles/_design-tokens.generated.css` for CSS variables and Tailwind utilities;
- `src/design-system/design-tokens.ts` for MUI and TypeScript consumers.

Generated files must never be edited manually. `npm run tokens:check` validates the manifest and verifies both outputs without modifying files. Token freshness is enforced exactly once by `prebuild`, `pretest:ts`, `pretest:ts:ci`, and `prebuild-storybook`; `test:ci` inherits the check through `test:ts:ci`.

The manifest contains light and dark semantic colors, spacing, fixed sizes, radii, typography, behavioral breakpoints, and shadows. Public names describe intent, including `background`, `surface`, `text`, `border`, `primary`, status colors, focus, and interaction state. Do not add public APIs named after raw colors.

Legacy variables in `_variables.css` are compatibility aliases where a matching Echo token exists. Keep legacy-only variables until a later migration, but do not duplicate a shared value in both files.

## Tailwind

Tailwind v4 uses CSS-first configuration in `src/styles/style.css`. No application or showcase JavaScript Tailwind configuration is loaded. Any future standalone showcase must use its own CSS entrypoint and explicit `@config`, or preferably CSS-first configuration. Use standard structural utilities such as `flex`, `grid`, `w-full`, and `min-w-0`, plus named Echo utilities for shared values:

```text
gap-echo-sm p-echo-lg h-echo-control-md size-echo-icon-sm
rounded-echo-md text-echo-sm bg-echo-surface text-echo-text
border-echo-border echo-md:grid-cols-2
```

Existing numeric utilities and standard breakpoints remain valid for legacy code. New code uses named Echo spacing and behavioral breakpoints. Repeated arbitrary values should become tokens.

## MUI

`createNeoMuiTheme(mode)` is deterministic and reads no DOM styles. It consumes the generated TypeScript tokens through `theme.echo`.

Compatibility-first policy: the generated semantic palette is available for future MUI work, but this foundation does not activate it as the global MUI palette. Any global palette migration requires explicit approval and light/dark visual regression coverage.

MUI's current spacing, breakpoints, component sizes, and verified typography behavior are compatibility APIs. In particular, `theme.spacing(1) === '8px'` and existing MUI breakpoint values must not change. JavaScript behavior that must match Echo responsive variants uses generated Echo breakpoints, not copied pixels.

Shared MUI values are semantic palette data, base typography, focus colors, and base radius. Layout spacing, dimensions, and responsive geometry are application/Tailwind concerns. MUI internal elevations, transitions, and similar implementation details remain private.

## Ownership boundary

Tailwind owns display, flex/grid, spacing, sizing, positioning, overflow, responsive geometry, and structural backgrounds, borders, radii, and shadows.

MUI or `Power*` owns buttons, fields, dialogs, drawers, menus, popovers, tabs, date/time pickers, validation, disabled behavior, focus management, and component-specific accessibility.

`EchoChip` owns dense, repeated application chip rendering. Prefer it in MRT item-overflow cells;
do not automatically use `PowerChip` there. `PowerChip` is the single MUI chip wrapper for
lower-density or behavior-rich surfaces and uses standard 14px typography.

New code must not introduce layout-only `Box`, `Stack`, `Grid`, or `Container`; wrappers that conceal them; structural `sx`; copied mode colors; clickable `div`s in place of semantic controls; or styling against generated `.Mui-*` class names. `sx` is allowed for documented MUI slots or states, component behavior, supported third-party boundaries, and dynamic values that stable classes or CSS variables cannot express.

## Skills and verification

The discoverable frontend implementation, accessibility, and regression-safety skills contain the concise enforceable rules and name this repository path for details. Duty rendering guidance remains in `.github/skills/duty-feed-rendering-safety` and is not treated as an installed/discoverable skill. No work depends on a separately installed layout skill.

For token or theme work run, at minimum:

```bash
cd wdintel-web
npm run tokens:check
npx vitest run src/ts/react/mui-theme.spec.tsx
npm run test:ts:ci
just build-front
```

Validate generated utilities and CSS variables in light and dark modes. If a global MUI palette is ever activated, cover representative light/dark buttons, fields, dialogs, drawers, tables, alerts, disabled controls, and focus states with screenshots.
