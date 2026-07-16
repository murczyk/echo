---
name: duty-feed-rendering-safety
description: Preserve Duty Neo scrolling, unread-state, windowing, hidden-feed behavior, and MessageCard hot-path performance when editing rer-duty-neo or shared/message-card React code, especially layout wrappers, MUI styling, responsive visibility, menus, polling, and scroll behavior.
---

# Duty Feed Rendering Safety

Use this skill for changes involving `rer-duty-neo`, shared MessageCard rendering, Duty scrolling/windowing, unread/read tracking, polling/watch mode, hidden narrow-screen feed columns, card layout or MUI wrapper refactoring, or menu/dialog mounting inside repeated cards.

## Procedure

1. Read the applicable path-local `AGENTS.md` first.
2. Identify whether the change affects repeated per-message rendering, scrolling or anchor restoration, polling or watch mode, unread/read state, hidden narrow-screen feeds, responsive geometry, conditional menu/dialog mounting, shared Analysis MessageCard behavior, or theme-aware visual parity.
3. Preserve native structural markup in the protected path.
4. Keep leaf MUI components where they provide theme, interaction, or accessibility behavior.
5. Integrate incoming functionality without restoring removed structural abstractions.
6. Avoid unrelated refactoring across the performance boundary.
7. Compare Duty and Analysis consumers whenever shared MessageCard code changes.
8. Run the relevant focused tests and `just build-front`.
9. Report explicitly when a requested feature requires an architectural exception.

## Boundary rules

- Do not introduce structural `Box`, `Stack`, `Grid`, `Container`, or equivalent wrapper components into the protected hot path.
- Do not add wrapper components whose only purpose is hiding those layout abstractions.
- Do not migrate native structural layout into per-card `sx` objects.
- Prefer semantic/native HTML, existing utility classes, and shared theme-backed CSS variables.
- Keep menus, dialogs, and popovers unmounted when practical.
- Preserve `memo`, stable defaults, and conditional rendering that reduce repeated work.
- Hidden narrow-screen feeds may remain mounted, but disabled tracking must not report visibility, bottom state, loading triggers, or read-state side effects.
- Preserve existing Duty windowing and scroll-anchor behavior.
- Do not restore Virtuoso to Duty without deliberate performance validation.

## Theme parity

- Preserve intended MUI typography semantics.
- Use existing variables or shared theme-backed variables for colors, dividers, spacing, radii, and interaction states.
- Do not target generated `.Mui-*` class names as an application styling API.
- Do not hard-code light/dark colors to imitate the theme.
- If a needed theme value is missing, add one shared theme-backed variable through the established theme/CSS bridge.

## Fast check

- Confirm whether the change touches repeated card rendering or hidden-feed behavior.
- Confirm native structure is preserved in the hot path.
- Confirm shared MessageCard changes are reviewed against both Duty and Analysis.
