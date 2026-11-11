# Sending messages to groups

In Directions, messenger sending can be enabled when the group occurs in at
least one non-deleted Signal or WhatsApp datasource that permits sending.
Membership comes from non-deleted `datasource_group` rows, independently of
the group's primary datasource. No eligible datasource means sending cannot
be enabled. Delivery prefers an active eligible datasource; ties use the
datasource display name, then its ID. If none is active, the same name order
selects the sender. Removed clients and account locks pending removal are
excluded from delivery.
Composing reuses existing datasource memberships without recreating removed
ones, preferring a surviving membership over a removed primary source.

The group must permit sending and include the author's organism in its sender
list. Otherwise the message is saved in Echo without a messenger delivery.
Editing an existing message does not queue another delivery.

The **+** composer in Duty and Analysis accepts multiple groups. The direct
submission API keeps `signal_group_master_key` as the primary destination and
accepts `additional_signal_group_master_keys` for additional destinations.
Every destination must be accessible and satisfy its group requirements.
Echo Native groups cannot be combined with external groups in one submission.
The message and attachments are stored once, with links to every selected
group. Repeated destinations are ignored. Saving and queuing all messenger
deliveries share one transaction, so a failure does not leave a partial send.
Replies, report creation, and editing retain a single destination.
If reloading group data removes a selected destination, the composer warns the
author and retains the other selected groups.

Report creation remembers its destination separately in browser localStorage
(`echo_lastReportDestination`). Selecting another group or **Не відправляти**
updates it; clearing the selection removes it. The next report restores this
choice, including after reload. A remembered group that is no longer accessible
is cleared from storage. Editing a report leaves this creation preference
unchanged. The minimal report window uses the same choice and shows its
destination; without a choice it keeps the report local.

Regression coverage:

- `wdintel-rs/src/messenger/group/native/tests.rs`
- `wdintel-rs/src/messenger/group/sending/tests.rs`
- `wdintel-web/tests/e2e/manage-message-drawer.spec.ts`
- `wdintel-web/tests/e2e/rer-duty-minimal-report.spec.ts`
