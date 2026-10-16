# Group Avatar Colors Design

**Status:** Proposed

**Issue:** [#3727](https://github.com/echoua/echo/issues/3727)

**Base branch:** `main`

## Context

Group navigation in Duty (`Оперативний`) and Analysis (`Аналіз`) currently
uses the first visible character of the group name on one neutral background.
With many groups, this makes the navigation list harder to scan. Administrators
also have no way to give a group a stable visual identity.

Every real signal group needs one persisted color identity. Existing groups
must receive colors as part of rollout, newly created groups must receive a
color automatically, and administrators must be able to select a replacement
from a controlled palette. Regular, orphan, and archived groups follow the same
rules.

## Goals

1. Give every real signal group a stable avatar color.
2. Assign colors automatically without requiring changes in every group-creation
   path.
3. Let administrators choose a color from a prepared, accessible palette in
   every group edit dialog.
4. Reuse one avatar and palette implementation across Duty, Analysis, and
   Administration.
5. Keep backend and schema changes narrow and add no new polling or requests.

## Non-goals

- Avatar images or uploads.
- Arbitrary HEX/RGB entry or a system color picker.
- A globally unique color per group. The system may contain more than one
  hundred groups, so palette colors intentionally repeat.
- Using color as the only indication of a group, selection, unread state, or
  status.
- Changing group ordering, unread calculations, feed filters, or permissions.
- Changing the special `Всі групи` avatar, which remains a neutral system icon
  rather than a persisted signal group.

## Color model

`signal_group` gains a required `color_key` column. The value is a stable key,
not a rendered color. The allowed keys are:

```text
red, pink, purple, deep_purple,
indigo, blue, light_blue, cyan,
teal, green, light_green, lime,
amber, orange, deep_orange, blue_grey
```

The database constrains the column to this set. The API represents the same set
as a generated backend-owned type so update requests cannot introduce arbitrary
values. Persisting semantic keys allows the UI's light and dark theme values to
evolve without data migrations.

The frontend owns one palette module that maps every key to a Material hue. It
uses the hue's `700` tone in light mode and `400` tone in dark mode. For every
background, it chooses whichever of `theme.palette.common.white` and
`theme.palette.grey[900]` provides the higher contrast, with a required minimum
ratio of 4.5:1. It uses no hard-coded `#000` fallback. An unknown runtime value
uses `theme.palette.action.selected` with `theme.palette.text.primary`.

The palette is an identity aid, not a guarantee of uniqueness. The group name
and its first visible Unicode grapheme remain the primary identification cues.

## Assignment and migration

The migration adds the column, assigns every existing group a palette key, then
enforces `NOT NULL`, the allowed-key check, and a database default.

Existing values are distributed deterministically by hashing `master_key` and
mapping the result into the 16-key palette. Re-running the assignment against
the same data produces the same colors and avoids a visually unstable rollout.

The database default chooses one of the same 16 keys randomly for a newly
inserted group. The default covers imports, synchronization workers, admin
actions, and future creation paths without duplicating selection logic in Rust
or JavaScript. No `random_color` dependency is introduced. A caller may only
supply a different valid key through an authorized edit operation.

## Backend contracts and data flow

The persisted color is exposed through the existing group representations used
by:

- group-feed navigation in Duty and Analysis;
- regular group rows and edit data in Administration;
- orphan and archived group rows and edit data in Administration.

Existing update endpoints accept `color_key` together with the other editable
group settings and persist it on `signal_group`. Existing authorization remains
the boundary for editing; adding a color does not broaden access.

Rust remains the source of API types. Frontend bindings are regenerated rather
than manually defining parallel request or response types. The color travels in
responses already fetched by each screen, so it creates no endpoint, polling,
or N+1 query.

## Shared frontend components

The existing shared `GroupAvatar` accepts the group color key and resolves its
theme-aware presentation through the shared palette module. Duty, Analysis,
group islands, navigation rows, and admin previews use this component instead
of implementing local color rules.

The `Всі групи` variant continues to render the Material all-groups icon with
neutral theme colors. Missing names still use the existing safe grapheme
fallback. A missing or unexpected color uses the neutral group style rather
than breaking rendering.

## Administration experience

Every editable group form, including regular, orphan, and archived groups,
contains a field labelled `Колір групи`. The field is a single-select radio
group rendered as a compact wrapping grid of the 16 circular swatches.

The field provides:

- the current group's initial as an immediate preview;
- a check mark and accessible selected state on the chosen swatch;
- keyboard navigation and a visible focus indicator;
- an accessible label for every color;
- responsive wrapping without horizontal scrolling.

Selecting a swatch updates only the local form preview. The value is persisted
with the existing `Зберегти` action. Canceling or closing the dialog discards
the pending selection. If saving fails, the dialog remains open and the
existing detailed API-error toast is shown.

## Rollout and compatibility

The schema migration runs before application code that requires `color_key`.
It fully backfills existing rows, so application code does not need a nullable
transition state. The UI still keeps a neutral fallback to tolerate stale
responses or a mixed-version browser session.

Because the database supplies the creation default, existing creation code only
needs changes where generated entity struct literals require the new field for
compilation. Those edits must remain mechanical and must not reformat unrelated
backend code.

## Testing

Backend and migration coverage must verify:

- every existing group receives one allowed non-null key;
- new groups receive an allowed key when the caller omits it;
- all 16 keys are accepted and an invalid value is rejected;
- regular, orphan, archived, and group-feed responses expose the persisted key;
- authorized edits persist the selected key and existing authorization still
  applies.

Frontend coverage must verify:

- all palette keys resolve in both theme modes and unknown values fall back;
- `GroupAvatar` renders the initial with the selected color while `Всі групи`
  remains neutral;
- each edit-dialog variant initializes, previews, cancels, saves, and reports
  failures correctly;
- Duty and Analysis render the persisted color through the same shared avatar;
- keyboard selection and focus behavior work for the palette.

E2E coverage must pin the administrator workflow and confirm that a saved color
is subsequently visible in group navigation without altering navigation,
filter, or unread behavior.
