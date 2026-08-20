# Shared MessageCard Instructions

This directory contains repeated card rendering plus dialogs and preview components. The structural restrictions apply only to the explicitly listed hot-path components, not blindly to every descendant file.

Protected hot path:

- `MessageCard.tsx`
- `MessageCardHeader.tsx`
- `MessageCardContent.tsx`
- `MessageCardTags.tsx` and other default/closed card content repeated across Duty feeds

Rules:

- Do not introduce structural `Box`, `Stack`, `Grid`, `Container`, or equivalent wrapper components into the protected hot path.
- Do not introduce custom wrapper components that only hide those MUI layout abstractions.
- Do not migrate native structural layout into per-card `sx` objects.
- Prefer semantic/native HTML, Tailwind utility classes, application-owned CSS classes, and shared theme-backed CSS variables.
- Use `sx`, `Box`, `Stack`, and other MUI layout/styling APIs only when absolutely necessary (for example theme-coupled leaf controls, menus, dialogs, popovers, or behavior that native HTML + Tailwind cannot provide). On repeated per-tag / per-card nodes, prefer static `className` over `sx` — Emotion/`sx` recalculates at runtime and multiplies cost across Duty feeds.
- Leaf MUI components (`Button`, `Menu`, `MenuItem`, `Typography`, icons, tooltips, progress indicators, dialogs, popovers) remain valid when they provide required theme, accessibility, or interaction behavior; style them with Tailwind or app-owned classes when a static class is enough.
- MUI layout components remain valid for dialogs, previews, controls, and other non-repeated surfaces.
- Do not interpret this rule as "remove all MUI".
- Closed menus, dialogs, and popovers should remain unmounted when practical.
- Preserve `memo`, stable default references, and conditional rendering used to reduce repeated work.
- On Duty, when user setting `dutyCollapseMediaPreviews` is on (default), heavy media stays behind reveal banners until opened; do not mount those players/previews on every closed card by default.
- If a requested change needs structural layout inside the protected hot path, stop and call out the performance trade-off before implementing it.

## Theme parity

- Native hot-path markup must remain visually consistent with the active MUI theme.
- Preserve intended typography hierarchy, inheritance, readability, and responsive behavior instead of encoding a fixed computed font size.
- Use existing semantic utilities and shared theme-backed CSS variables for colors, dividers, spacing, radii, and interaction states.
- Do not target generated `.Mui-*` class names as an application styling API.
- Do not hard-code light/dark colors or unrelated constants to imitate MUI styling.
- Prefer existing variables such as `--color-action` and `--color-divider` when applicable.
- If a required semantic theme value is unavailable, add one through the established shared theme/CSS bridge rather than introducing per-card hard-coded styling.
- Keep leaf MUI components when they provide the required theme, accessibility, or interaction behavior.
- Use filled MUI icons for actionable controls by default; use outlined variants only where an established visual or semantic convention specifically requires them.
- MUI buttons rendered as anchors within `.rer-duty` must locally override generic link-inheritance styles with higher-specificity `sx` when using a semantic contained color.
