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
- Prefer semantic/native HTML, existing utility classes, and shared theme-backed CSS variables.
- `sx` remains valid on leaf or interactive MUI components such as `Button`, `Menu`, `MenuItem`, `Typography`, icons, tooltips, progress indicators, dialogs, and popovers.
- MUI layout components remain valid outside the protected repeated path, including workspace shells, panels, dialogs, media previews, controls, and XLSX rendering.
- Do not interpret this rule as "remove all MUI".
- Closed menus, dialogs, and popovers should remain unmounted when practical.
- Preserve `memo`, stable default references, and conditional rendering used to reduce repeated work.
- Hidden narrow-screen feeds remain mounted, but inactive feeds must not report visibility, bottom position, loading triggers, or read-state side effects.
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
