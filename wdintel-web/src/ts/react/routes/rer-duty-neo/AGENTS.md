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
