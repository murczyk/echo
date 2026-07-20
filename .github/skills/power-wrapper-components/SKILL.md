---
name: power-wrapper-components
description: Prefer existing Power* wrapper components over raw MUI primitives when a matching wrapper exists in wdintel-web.
---

# Power Wrapper Components

## Short description

Use when adding or refactoring React + MUI UI in `wdintel-web/src/ts/react`.

## When to use / When NOT to use

- Use: when a `Power*` wrapper exists for the control you need.
- Use: when adding new UI that should inherit app-specific behavior, locale, or styling.
- Do not use: when there is no matching wrapper and the raw MUI component is the correct choice.

## Guidance

- Prefer `PowerChip` over `Chip`.
- Prefer `PowerButton` over `Button` when a wrapper exists and fits the use case.
- Prefer `PowerDatePicker` / `PowerDateTimePicker` over native MUI date and time pickers.
- Prefer `PowerMenu`, `PowerAlert`, `PowerSnackbar`, and other existing wrappers over raw MUI components. Use `PowerSnackbar` for transient action feedback and `PowerAlert` for contextual/static content.
- Check `wdintel-web/src/ts/react/components` before introducing a new raw MUI primitive in routes or shared UI.

## Why

- Wrappers centralize app-specific behavior, styling, locale, and interaction contracts.
- Raw MUI usage is acceptable when there is no matching wrapper or when the wrapper does not fit the required behavior.

## Definition of Done

- Existing wrappers are reused where appropriate.
- New repeatable MUI patterns are considered for a shared `Power*` wrapper.
