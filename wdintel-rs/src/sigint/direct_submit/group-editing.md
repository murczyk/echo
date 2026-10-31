# Editing message groups (#3955)

`POST /api/1.1/message/{id}/edit` accepts the optional
`source_signal_group_master_key` alongside the destination
`signal_group_master_key`. The source must be an accessible membership of the
message. The editor sends its displayed group as the source. An unchanged source
and destination allow ordinary text edits without changing a different canonical
datasource group. A changed destination requires `DeleteMsg` for ordinary
messages; reports retain their existing editing permissions.

Older clients omit the source. They use the canonical datasource group, or the
earliest accessible membership when that canonical group is absent. Moves replace
the source membership while preserving independent memberships. An existing
destination membership is reused with its receipt metadata intact. Legacy
memberships without datasource IDs are matched by their master key.

Group replacement requeues settlement resolution for the new responsibility
areas. Statistics capture the old and new activity windows in the same
transaction. Duty reconciles displayed, buffered, and retained unread identities
against active group filters while preserving its creation-time ordering and
historical read boundaries.

Regressions: `wdintel-rs/src/sigint/direct_submit/bl.rs`,
`wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeeds.spec.ts`,
and `wdintel-web/tests/e2e/group-feed-message-lifecycle.spec.ts`.
