# Group filter widgets and unread state

Duty and Analysis group widgets are views of the legacy group filter.
They load the existing catalog and do not fetch or acknowledge per-group read
state. Selecting a group preserves the remaining filters; both headers summarize
the same selected group keys. Group names, persisted colors, avatars, and admin
color editing remain supported. See [Group navigation](../../group-feed-navigation.md).

The per-group unread feature has been removed: no badges, read-through cursors,
read receipts, persisted unread dividers, or first-unread navigation. Its GET
and acknowledgement endpoints, generated API bindings, and browser store are
removed too. A future task will define new per-group unread behavior.

Existing Duty feed unread counts, viewport reading, polling, browser-title and
tab indicators, local unread divider, and bottom-arrow navigation remain active.
Group selection uses the same filter reload as the legacy group filter, including
its unread baseline reset. Analysis retains its existing message count.

The already-applied read-state migration and its analytics exclusion remain
unchanged. The application no longer reads or writes the historical table;
removing it does not require a destructive schema change in this fix.

Coverage:

- `wdintel-web/tests/e2e/group-filter-widgets.spec.ts`.
- `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx`.
- `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeedState.polling.spec.tsx`.
- `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/FeedColumnContent.spec.tsx`.
