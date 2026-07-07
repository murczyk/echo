# React Power Components

Shared app wrappers for repeated UI behavior in `wdintel-web`.

## `PowerForm`

Use for forms in dialogs, drawers, and pages when you want app-wide submit behavior.

- `keyboardSubmit` is enabled by default.
- `keyboardSubmit={false}` disables Enter / Cmd+Enter / Ctrl+Enter handling.
- `canSubmit={boolean | () => boolean}` blocks both keyboard submit and native submit.
- Single-line inputs submit on `Enter`.
- Textareas submit on `Cmd+Enter` / `Ctrl+Enter`.

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

Use for dismissible alerts with optional auto-hide timing.

```tsx
<PowerAlert severity="error">...</PowerAlert>
```

## `PowerMenu`

Use for menus that should keep the app's Escape handling consistent inside dialogs.

```tsx
<PowerMenu open={open} anchorEl={anchorEl} onClose={handleClose}>
```

## `PowerChip`

Use for selectable chips with app styling.

```tsx
<PowerChip label="Активний" selected onClick={handleClick} />
```

## `CompactPowerChip`

Use for compact chip variants in dense UI.

```tsx
<CompactPowerChip label="Тег" />
```

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
