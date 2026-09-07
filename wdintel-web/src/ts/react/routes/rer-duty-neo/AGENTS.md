# Duty Neo Route Instructions

MUI remains the application design system, but repeated Duty feed rendering is a performance-sensitive boundary. Do not replace lightweight native structural markup with MUI layout abstractions merely for consistency or convenience.

Protected hot path:

- `MessageCard.tsx`
- `MessageCardHeader.tsx`
- `MessageCardContent.tsx`
- `DutyMessageCardItem`
- `DutyMessageList`
- default or closed card content repeated across Duty feeds

Rules:

- Do not introduce structural `Box`, `Stack`, `Grid`, `Container`, or equivalent wrapper components into the protected hot path.
- Do not introduce custom wrapper components that only hide those MUI layout abstractions.
- Do not migrate native structural layout into per-card `sx` objects.
- Prefer semantic/native HTML, Tailwind utility classes, application-owned CSS classes, and shared theme-backed CSS variables.
- Use `sx`, `Box`, `Stack`, and other MUI layout/styling APIs only when absolutely necessary (for example theme-coupled leaf controls, menus, dialogs, popovers, or behavior that native HTML + Tailwind cannot provide). On repeated per-tag / per-card nodes, prefer static `className` over `sx` — Emotion/`sx` recalculates at runtime and multiplies cost across Duty feeds.
- Leaf MUI components (`Button`, `Menu`, `MenuItem`, `Typography`, icons, tooltips, progress indicators, dialogs, popovers) remain valid when they provide required theme, accessibility, or interaction behavior; style them with Tailwind or app-owned classes when a static class is enough.
- MUI layout components remain valid outside the protected repeated path, including workspace shells, panels, dialogs, media previews, controls, and XLSX rendering.
- Do not interpret this rule as "remove all MUI".
- Closed menus, dialogs, and popovers should remain unmounted when practical.
- Preserve `memo`, stable default references, and conditional rendering used to reduce repeated work.
- On narrow multi-feed, mount only the active feed column’s card tree; inactive feeds stay in state but must not keep live MessageCard mounts, scroll tracking, loads, or read-state side effects.
- On desktop multi-feed (`feedCount >= 2`), keep all columns visible. After ~10s without pointer/wheel/touch on a feed, off-viewport MessageCards in that feed become height placeholders (`useFeedIdleViewportOffload`); interaction wakes the feed and remounts the full window. Programmatic follow/settle scroll must not count as interaction.
- Window `items` identity changes should commit via `startTransition` (`commitFeedWindowUpdate`) so scrolling stays responsive during MessageCard reconcile; keep urgent updates for loading flags and physical-bottom / follow / activate flushes.
- Near-bottom newer pages that are not following stay in `pendingNewerItems` (off DOM) until scroll idle / physical bottom / follow / arrow — do not force those pages into `items` mid-scroll in the near zone.
- Closed card action chrome should prefer native `button` + CSS (not always-mounted Tooltip/`Button`/`ButtonBase`) on the repeated Duty row; keep MUI menus unmounted until opened.
- When `dutyCollapseMediaPreviews` is enabled (user setting, default on), do not mount audio players, image/video thumbs, or coordinate map previews until the user opens the applicable exclusive attachment control. The shared setting applies to both Duty and Analysis.
- Preserve the current custom Duty windowing and scroll-anchor behavior.
- Do not restore Virtuoso to the Duty feed without deliberate performance validation. Its XLSX usage is valid and unrelated.
- Do not reverse these decisions during cleanup or unrelated feature work.
- If requested functionality genuinely requires crossing this boundary, stop and explain the performance trade-off before implementing it.

## Theme parity

- Native hot-path markup must remain visually consistent with the active MUI theme.
- Preserve intended typography hierarchy, inheritance, readability, and responsive behavior instead of encoding a fixed computed font size.
- Use existing semantic utilities and shared theme-backed CSS variables for colors, dividers, spacing, radii, and interaction states.
- Do not target generated `.Mui-*` class names as an application styling API.
- Do not hard-code light/dark colors or unrelated constants to imitate MUI styling.
- Prefer existing variables such as `--color-action` and `--color-divider` when applicable.
- If a required semantic theme value is unavailable, add one through the established shared theme/CSS bridge rather than introducing per-card hard-coded styling.
- Keep leaf MUI components when they provide the required theme, accessibility, or interaction behavior.
