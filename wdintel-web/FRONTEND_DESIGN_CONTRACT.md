# Frontend layout and component contract

## Objective

New React UI uses native HTML and Tailwind for structure and layout, while MUI remains the component system for controls and interaction behavior. Both styling systems consume the same Echo design tokens.

This contract establishes the target architecture. It does not require unrelated legacy layout to be migrated when a file is touched.

## Ownership boundary

| Concern                        | Owner                                               | Examples                                                                                          |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Document semantics             | Native HTML                                         | `main`, `section`, `header`, `nav`, `form`, headings, lists                                       |
| Layout and geometry            | Tailwind                                            | display, grid/flex, gap, padding, margin, width, height, overflow, positioning, responsive layout |
| Interactive components         | MUI or an existing `Power*` wrapper                 | buttons, fields, dialogs, drawers, menus, tabs, tooltips, date pickers                            |
| Component internals and states | MUI theme, component props, or narrowly scoped `sx` | MUI slots, validation state, selected/disabled state, library-specific selectors                  |
| Shared visual values           | Echo design tokens                                  | colors, spacing, sizes, radii, type sizes, shadows, breakpoints                                   |

Do not introduce `Box`, `Stack`, `Grid`, or `Container` for layout in new code. Do not create an application wrapper that merely hides one of those components. `Paper` and `Card` are appropriate only when their component semantics or behavior are useful; a visual surface alone is a native element with Tailwind.

Prefer an existing `Power*` wrapper over its raw MUI equivalent when the wrapper matches the behavior. MUI remains responsible for accessibility and interaction behavior that would be costly or risky to recreate.

## Required composition pattern

```tsx
<section className="flex flex-col gap-echo-lg rounded-echo-md bg-echo-surface p-echo-xl">
  <header className="flex items-center justify-between gap-echo-sm">
    <h2 className="text-echo-lg text-echo-text">Title</h2>
    <PowerButton onClick={onCreate}>Create</PowerButton>
  </header>

  <div className="grid grid-cols-1 gap-echo-md echo-md:grid-cols-2">
    <TextField label="Name" />
    <TextField label="Code" />
  </div>
</section>
```

Use semantic elements when they communicate structure. Use `div` only when no more meaningful element applies.

## Styling rules

### Tailwind owns layout

Use Tailwind for structural properties, including layout on a MUI component's outer root when that component reliably forwards `className`. Prefer a native wrapper if root forwarding or portal behavior is unclear.

Structural `sx` is not allowed in new code. Examples include `display`, `gridTemplateColumns`, `flex*`, `gap`, margin, padding, positioning, dimensions, and responsive layout objects.

### MUI owns components

Use component props and the shared theme before adding overrides. `sx` remains acceptable when it targets genuine component behavior that Tailwind cannot express cleanly, such as:

- a MUI slot or documented state class;
- a value derived from MUI component state;
- a third-party component API that accepts `sx` as its styling boundary;
- a calculated runtime value that cannot be represented by a stable utility or CSS variable.

Keep such `sx` narrow and outside repeated render hot paths when possible. Do not target generated `.Mui-*` class names as an application API.

### Dynamic values

Prefer a CSS custom property plus a stable Tailwind utility for runtime values:

```tsx
<div
  className="w-(--panel-width)"
  style={{ '--panel-width': `${panelWidth}px` } as CSSProperties}
/>
```

Inline `style` is an escape hatch for genuinely dynamic values, not a replacement layout system. Repeated values belong in the shared tokens.

### Accessibility

Changing the styling owner does not change semantic or accessibility requirements. Preserve labels, keyboard behavior, focus visibility, heading order, live/error messaging, and responsive reading order. Never replace a semantic or interactive element with a clickable `div`.

## Shared token architecture

The token flow is:

```text
src/design-system/tokens.json
          +
src/styles/_variables.css (existing light/dark color values)
          |
          v
scripts/design-tokens.mjs
          |
          v
src/styles/_design-tokens.generated.css
          |
          +--> Tailwind echo-* utilities
          |
          +--> MUI theme palette and theme.echo tokens
```

- `src/design-system/tokens.json` is the source of truth for spacing, sizes, radii, font sizes, shadows, shared breakpoints, and mappings to the existing semantic color variables.
- `src/styles/_variables.css` remains the source of truth for light/dark color values during the migration. Do not duplicate those color values in MUI or Tailwind configuration.
- `src/styles/_design-tokens.generated.css` is generated. Never edit it directly.
- `src/ts/react/mui-theme.ts` resolves the same color references into the MUI palette and exposes non-color values under `theme.echo`.
- `tailwind.config.js` is retained for legacy/showcase compatibility. It is not the design-token source for the Tailwind v4 application build.

The global theme selector remains `html[data-bs-theme='dark']`. New components must not add their own light/dark palette branches when a semantic token can express the intent.

## Token usage

New token-sensitive Tailwind values use the `echo` namespace:

| Purpose              | Tailwind                                                  | CSS                           | MUI theme                                              |
| -------------------- | --------------------------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| Spacing              | `gap-echo-sm`, `p-echo-lg`                                | `var(--echo-spacing-sm)`      | `theme.echo.spacing.sm`                                |
| Fixed component size | `h-echo-control-md`, `size-echo-icon-sm`                  | `var(--echo-size-control-md)` | `theme.echo.size.controlMd`                            |
| Radius               | `rounded-echo-md`                                         | `var(--echo-radius-md)`       | `theme.echo.radius.md`                                 |
| Type size            | `text-echo-sm`                                            | `var(--echo-font-size-sm)`    | `theme.echo.fontSize.sm`                               |
| Shadow               | `shadow-echo-md`                                          | `var(--echo-shadow-md)`       | `theme.echo.shadow.md`                                 |
| Color                | `bg-echo-surface`, `text-echo-text`, `border-echo-border` | `var(--echo-color-surface)`   | semantic `theme.palette.*` value                       |
| Responsive layout    | `echo-md:grid-cols-2`                                     | `var(--echo-breakpoint-md)`   | `theme.echo.breakpoint.md` for behavioral queries only |

Framework primitives that are not design decisions remain unnamespaced, such as `flex`, `grid`, `w-full`, `min-w-0`, `overflow-hidden`, and `items-center`.

Use the named Echo spacing and breakpoint utilities for new layout instead of numeric spacing (`gap-4`) or framework breakpoint variants (`md:`). This allows the shared scale to evolve without changing framework defaults or legacy screens.

MUI's built-in `theme.spacing` and `theme.breakpoints` remain unchanged for legacy compatibility. New layout must not depend on them. When JavaScript behavior must match an Echo responsive boundary, construct the media query from `theme.echo.breakpoint`; do not guess or duplicate the pixel value.

Arbitrary values are acceptable for values that are intrinsically local or data-driven. If the same design value appears more than once, add a token instead.

## Adding or changing a token

1. Update `src/design-system/tokens.json`.
2. For a new color, define its light/dark semantic value in `src/styles/_variables.css` and add only its custom-property reference to `colorReference`.
3. Run `npm run tokens:generate` from `wdintel-web`.
4. If the token belongs in the MUI palette, map it in `src/ts/react/mui-theme.ts` using the shared reference. Do not copy its color value.
5. Run `npm run tokens:check`, focused tests, and `just build-front`.

The frontend build and TypeScript test commands fail when generated tokens are stale.

## Legacy migration policy

- Do not perform opportunistic whole-file rewrites merely because legacy `Box` or structural `sx` is present.
- New structural code follows this contract immediately.
- When a requested change directly modifies a legacy layout region, migrate only the smallest coherent region when doing so is safe and reviewable.
- Preserve visual behavior, responsive boundaries, semantics, focus behavior, and tests during migration.
- Duty/MessageCard hot paths remain subject to their stricter rendering-safety rules.

## Review checklist

- Native semantic HTML owns the structure.
- Tailwind owns layout and responsive geometry.
- MUI or `Power*` owns interactive component behavior.
- No new structural MUI wrapper or layout-only `sx` was introduced.
- Theme-sensitive values use Echo tokens, not copied hex/RGB values or local dark-mode branches.
- Repeated arbitrary values were promoted to tokens.
- JavaScript media queries use the shared Echo breakpoint values.
- Light/dark, mobile/tablet/desktop, keyboard, focus, loading, empty, and error states remain valid where applicable.
