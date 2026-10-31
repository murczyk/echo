# Role settings for message creation

The second tab at `/admin/users-neo`, **Налаштування ролей**, lets administrators
create, edit, and delete one settings card per role. A role already configured
cannot be selected again. The role on an existing card is fixed; delete its
settings to configure a different role.

The three rules control whether a unit and device name are required, and whether
inline unit creation is allowed. They apply to new messages, replies, copies,
and intelligence reports. Existing message/report edits and the unit catalog
keep their existing behavior.

Only explicitly assigned roles with saved settings participate. Each rule uses
the most permissive configured value: required flags are combined with AND,
and creation permission with OR. Unconfigured roles do not weaken saved rules;
users with no matching settings retain optional unit/device fields and inline
unit creation. Role rules take precedence over personal form defaults, including
remembered empty fields. Server restrictions and ordinary authorization keep
precedence over role rules. Device requirements apply only while the server
allows devices and the user can access message devices.

The editor fetches effective rules when a creation form opens and blocks saving
until they load. Failures display an error and offer retry. The backend reloads
rules before saving a new message/report or creating a unit through the message
form, so changing browser values cannot bypass restrictions. Editing a message
does not fetch or evaluate these creation rules. Inline unit creation during an
edit passes `editing_message_id`; the server verifies that the message is editable
before using the existing edit behavior.

Settings live in `role_message_settings`, excluded from analytics replication.
Normal deployment synchronizes packaged exclusions before applying the new
migration. Roll back the application before dropping the table; dropping it
removes saved role rules.

Regression coverage:

- `wdintel-rs/src/users/role_settings/tests.rs`
- `wdintel-web/tests/e2e/role-message-settings.regression.spec.ts`
- `wdintel-web/tests/e2e/admin-users-neo.spec.ts`
