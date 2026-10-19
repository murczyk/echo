# Group read state

See [Group feed navigation](../../group-feed-navigation.md) for route state,
API, shared caching, avatar colors, and administration behavior.

Duty and Analysis advance each group's persisted read position while messages are
visible in an active browser tab. A row qualifies when at least half of the row
or half of the viewport is visible for 300 ms. Counters use the server's response
and decrease as the reader progresses; reaching the end of the feed is not
required. Content-restricting filters retain their existing acknowledgement guard.
Duty keyword highlighting only decorates message text and does not pause receipts,
including when a keyword set is restored from the column URL.

The read position is a monotonic creation-time watermark. Reading a message marks
that message and earlier messages in its group as read, irrespective of the
Analysis display order or event-time preference. The browser compares
`createdAtOrder` (microseconds), with `createdAt * 1000` as the legacy fallback.
Requests retain the millisecond API timestamp; the server validates group access,
message membership and the timestamp, then stores the original database precision.
An older receipt cannot move the watermark backwards. Concurrent feed receipts
for one group are serialized in the shared store.
Own messages, identified by `signal_message.login_id`, never contribute to the
author's unread count or oldest unread reference. Creation does not advance the
author's watermark or acknowledge earlier messages from other users. Inbox
responses expose nullable `is_own`; own rows do not trigger read receipts or
become the unread divider boundary, regardless of the selected group scope.
Messages shared by several accessible groups advance each returned membership;
membership is not narrowed by display-group or sender filters, and inaccessible
groups are never returned. The displayed group name is not the membership source.
Transient receipt failures can retry on reload or further reading without an
automatic conflict retry loop.

Visible rows are retained while group metadata loads so a late unread-state
response still acknowledges messages already being read. Closing group navigation
does not pause reading, including in the all-groups feed. Hidden tabs and inactive
Duty columns do not start read receipts. Ordinary navigation to the oldest unread
message scrolls to it without a linked-message outline; explicit message links and
editor highlights keep their existing appearance.
Analysis's unread-message window uses the destination group's restored filters
and current query state, rather than the page's initial URL filters.

An open creation draft keeps its original group when navigation changes on Duty
or Analysis. Starting another creation intent still asks before discarding a dirty
draft; ordinary group browsing never clears or silently retargets it.

Duty shows one primary-colored “Непрочитані повідомлення” divider before the first unread
row. Analysis retains this implementation but hides it by default through
`ANALYSIS_SHOW_UNREAD_DIVIDER` in
`wdintel-web/src/ts/react/routes/rer-analysis-neo/config.ts`;
`AnalysisMessagesPane` can override it with `showUnreadDivider`.
Hiding the divider does not disable read receipts or unread counters.
When enabled, its position stays fixed for the current group/filter/load session while
receipts decrease the counters and later messages arrive, including responsive
column remounts. It resets on a new session; a session without unread messages
starts without a divider. The boundary uses a frozen copy of each group's
microsecond-precision read position, including a late metadata response, or the
feed's loaded unread identities for new arrivals. It still identifies visible
unread rows when a filter or window excludes the globally oldest unread message.
Older API responses fall back to matching the oldest unread reference.
Successfully creating a message hides the divider only in its source column for
the rest of that session, without changing read receipts or unread counters.
Opening or cancelling the composer, a failed submission, and creating a report
do not dismiss it.
A live window commit clears a
stale linked-message outline even when no loading phase preceded it; editor
highlighting remains independent.

Coverage: `wdintel-rs/src/rer_importer/group_feed_state.rs`,
`wdintel-rs/src/rer_importer/inbox/mod.rs`,
`wdintel-web/src/ts/react/routes/shared/group-navigation/__tests__/group-feed-state-store.spec.ts`,
`wdintel-web/src/ts/react/routes/shared/message-feed/__tests__/MessageFeed.spec.tsx`,
`wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/FeedColumnContent.spec.tsx`,
`wdintel-web/tests/e2e/group-feed-navigation-analysis.spec.ts`,
`wdintel-web/tests/e2e/group-feed-navigation-duty.spec.ts`,
`wdintel-web/tests/e2e/group-feed-unread-state.spec.ts`,
`wdintel-web/tests/e2e/group-feed-two-users.spec.ts` and
`wdintel-web/tests/e2e/analysis-neo.spec.ts`.

## Browser regression matrix

`wdintel-web/tests/e2e/group-feed-two-users.spec.ts` covers the 24 combinations
of author route (Duty/Analysis), reader route (Duty/Analysis), author scope
(selected group/all groups), and reader scope (same group/another group/all
groups). Creation uses the actual editor in an isolated author browser context;
the reader receives long-poll events in a separate context. A visible incoming
row is read after the dwell period; an incoming row in another group remains
unread until viewed. Own submissions never contribute to either group badges or
the all-groups badge, and do not generate own-row read receipts.

`wdintel-web/tests/e2e/group-feed-message-lifecycle.spec.ts` reuses
`wdintel-web/tests/e2e/group-feed-actors.fixtures.ts` for both routes:

- persisted unread/read state across reloads, group changes, and another tab on
  the other route;
- hidden-document and off-screen reading guards, progressive reading, bounded
  pagination, and visible own rows above unread foreign history;
- content-restricting filters, shared group memberships, Duty-hidden groups,
  and inaccessible memberships;
- duplicate events, late metadata, failed receipts, and a new arrival while an
  older receipt response is pending;
- a stable divider during reading and new arrivals; composer cancellation,
  failed creation, and successful own creation;
- editing without reintroducing unread state, deletion of unread messages,
  distinct creation/interception times, both Analysis sort directions, and
  active/inactive or duplicate Duty columns.

The shared fixture implements HTTP responses and a per-user monotonic read
watermark; it does not replace React components, event handling, visibility
observers, or the editor. These are browser integration tests, not live-backend
end-to-end tests. Backend ownership, authorization, and watermark correctness
are independently covered by the database-backed tests named above.

The existing navigation and unread-state suites retain coverage of stale target
navigation, access revocation, conflicts, restored filters, and closed panels;
the new matrix supplements rather than replaces them.

`wdintel-web/tests/e2e/group-feed-duty-reading.spec.ts` covers keyword-highlighted
columns with navigation closed: live follow at the group tail, reading after
switching from another group, and returning to all groups from an unread target.
`wdintel-web/tests/e2e/group-feed-analysis-divider.spec.ts` verifies that the
disabled Analysis divider does not prevent reading in a group or all groups.

### Delayed acknowledgement responses

The lifecycle scenario `does not overwrite a new unread message with an older
acknowledgement response` protects the shared store in
`wdintel-web/src/ts/react/routes/shared/group-navigation/group-feed-state-store.ts`.
An acknowledgement response updates its group directly only if no invalidation
or refresh has started or completed since it was sent. Otherwise the store
fetches the authoritative state, including with group navigation closed, so a
newer unread message keeps its badge. A receipt without an overlapping state
change still updates its group directly without an extra GET.
