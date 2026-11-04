# Group requirements for message creation

Group editing in Directions and Settings → My Groups exposes **Обов’язковий
підрозділ** and **Обов’язкова назва пристрою**. These apply to every user sending
a new message, reply, copy, or intelligence report to that group, through the
web UI or API. A reply without an explicit destination uses its resolved reply
group. A report kept locally has no destination requirements. Existing message
edits remain valid without filling newly required fields.

The message editor validates the currently selected group's requirements and
updates them when the destination changes. The server validates them again
before saving. Required device names still require device access; users without
that access cannot send to a group requiring a device. `POST /api/1.1/submit`
accepts an optional `device_name_id`, as does the direct submission API.

Creating units through message forms or `create_unit` requires `UnitsEditor`
access, including administrators under the standard role hierarchy. Selecting
existing units remains available to message writers. All standalone unit creation
endpoints enforce the same permission. Role presets and their admin endpoints
have been removed.

The database fields `signal_group.is_sigint_unit_mandatory` and
`signal_group.is_device_mandatory` are nullable booleans with `false` defaults;
`NULL` also means optional. Migration `m20261104_083000_group_message_requirements`
drops the old `role_message_settings` table and its saved rules. Its analytics
impact requests a targeted resnapshot of `signal_group` to populate historical
values and publish the schema; no other replicated table needs a resnapshot.
Rollback recreates an empty presets table and removes the group flags; it does
not recover deleted presets.

Regression coverage:

- `wdintel-rs/src/messenger/group/requirements/tests.rs`
- `wdintel-rs/src/message_reply/tests_api.rs`
- `wdintel-web/tests/e2e/group-message-requirements.regression.spec.ts`
- `wdintel-web/tests/e2e/admin-users-neo.spec.ts`
- `wdintel-web/tests/e2e/manage-message-unit.regression.spec.ts`
