# React Power Components

Shared app wrappers for repeated UI behavior in `wdintel-web`.

## `PowerForm`

Use for forms in dialogs, drawers, and pages when you want app-wide submit behavior.

- `keyboardSubmit` is enabled by default.
- `keyboardSubmit={false}` disables keyboard-triggered submit shortcuts.
- `canSubmit={boolean | () => boolean}` blocks both keyboard submit and native submit.
- Single-line inputs submit on `Enter`.
- Textareas submit on `Cmd+Enter` / `Ctrl+Enter`.
- Use `canSubmit={false}` when the whole form must stay blocked.

```tsx
<PowerForm canSubmit={canSave} onSubmit={handleSubmit}>
```

## `PowerAutocomplete`

Use for multi-select autocomplete inputs with app-specific bulk paste and bulk-add behavior.

```tsx
<PowerAutocomplete bulkPaste options={options} value={value} onChange={handleChange} />
```

## `PowerButton`

Use for buttons that need the app double-submit guard.

```tsx
<PowerButton onClick={handleSave}>Зберегти</PowerButton>
```

## `PowerIconButton`

Use for icon buttons that need the same double-submit guard.

```tsx
<PowerIconButton aria-label="Оновити" onClick={handleRefresh}>
```

## `PowerAlert`

Use for contextual or static content: loading and empty states, validation or
load/reference errors, permission and gating warnings, and persistent information.

```tsx
<PowerAlert severity="error">...</PowerAlert>
```

## `PowerSnackbar`

Use for transient, non-blocking action feedback. Place
`<PowerSnackbarProvider>` inside the route's MUI theme provider, then call
`usePowerSnackbar()` with `success`, `info`, `warning`, or `error` severity.
Notifications are queued FIFO in a single bottom-right Snackbar and dismiss
automatically. Include safe-area-aware insets when the route has floating controls.

```tsx
<ThemeProvider theme={theme}>
  <PowerSnackbarProvider>
    <Page />
  </PowerSnackbarProvider>
</ThemeProvider>
```

```tsx
const { notify } = usePowerSnackbar();

notify({
  severity: 'success',
  message: 'Зміни збережено.',
});
```

Use one provider per independently mounted React root. Route-specific insets
are required when floating controls occupy the bottom-right corner.

Raw MUI `Snackbar` must not be used outside `PowerSnackbar`.

New transient action feedback must use `PowerSnackbar`; legacy timed
`PowerAlert` usages remain temporarily for migration compatibility.

| Message meaning                               | Component       |
| --------------------------------------------- | --------------- |
| Save/create/import succeeded                  | `PowerSnackbar` |
| Non-contextual action failed                  | `PowerSnackbar` |
| Form validation or submission error           | `PowerAlert`    |
| Page/section loading failure                  | `PowerAlert`    |
| Permission, warning or persistent information | `PowerAlert`    |

## `PowerMenu`

Use for menus that should keep the app's Escape handling consistent inside dialogs.

```tsx
<PowerMenu open={open} anchorEl={anchorEl} onClose={handleClose}>
```

## `PowerChip`

Use for low-density or behavior-rich MUI chip features and selectable chips with app styling. Its
standard typography is 14px. Use `EchoChip` for dense repeated native chips such as MRT overflow
previews and message-card tags.

```tsx
<PowerChip label="Активний" selected onClick={handleClick} />
```

## `EchoChip`

Use for app-owned repeated dense chips. It is native HTML and does not add MUI/Emotion work to
large table cells. It becomes an anchor for `href`, a button for `onClick`, and otherwise a span.

## `PowerDatePicker`

Use for the app date picker wrapper with the shared picker defaults.

```tsx
<PowerDatePicker value={date} onChange={setDate} />
```

## `PowerDateTimePicker`

Use for the app date-time picker wrapper with the shared picker defaults.

```tsx
<PowerDateTimePicker value={dateTime} onChange={setDateTime} />
```

## `PowerPickerActionBar`

Use for the shared picker action bar when custom picker buttons are needed.

```tsx
<PowerPickerActionBar powerActions={['clear', 'today', 'accept']} />
```
