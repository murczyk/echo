# Shared MessageCard Instructions

This directory contains repeated card rendering plus dialogs and preview components. The structural restrictions apply only to the explicitly listed hot-path components, not blindly to every descendant file.

Protected hot path:

- `MessageCard.tsx`
- `MessageCardHeader.tsx`
- `MessageCardContent.tsx`
- default or closed card content repeated across Duty feeds

Rules:

- Do not introduce structural `Box`, `Stack`, `Grid`, `Container`, or equivalent wrapper components into the protected hot path.
- Do not introduce custom wrapper components that only hide those MUI layout abstractions.
- Do not migrate native structural layout into per-card `sx` objects.
- Prefer semantic/native HTML, existing utility classes, and shared theme-backed CSS variables.
- `sx` remains valid on leaf or interactive MUI components such as `Button`, `Menu`, `MenuItem`, `Typography`, icons, tooltips, progress indicators, dialogs, and popovers.
- MUI layout components remain valid for dialogs, previews, controls, and other non-repeated surfaces.
- Do not interpret this rule as "remove all MUI".
- Closed menus, dialogs, and popovers should remain unmounted when practical.
- Preserve `memo`, stable default references, and conditional rendering used to reduce repeated work.
- If a requested change needs structural layout inside the protected hot path, stop and call out the performance trade-off before implementing it.
