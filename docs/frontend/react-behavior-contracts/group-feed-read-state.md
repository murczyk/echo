# Group read state

Duty and Analysis advance each group's persisted read position while messages are
visible in an active browser tab. A row qualifies when at least half of the row
or half of the viewport is visible for 300 ms. Counters use the server's response
and decrease as the reader progresses; reaching the end of the feed is not
required. Content-restricting filters retain their existing acknowledgement guard.

The read position is a monotonic creation-time watermark. Reading a message marks
that message and earlier messages in its group as read, irrespective of the
Analysis display order or event-time preference. The browser compares
`createdAtOrder` (microseconds), with `createdAt * 1000` as the legacy fallback.
Requests retain the millisecond API timestamp; the server validates group access,
message membership and the timestamp, then stores the original database precision.
An older receipt cannot move the watermark backwards. Concurrent feed receipts
for one group are serialized in the shared store.
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
Analysis's unread-message window uses the destination group's restored filters,
including sender and text search, rather than the page's initial URL filters.

An open creation draft keeps its original group when navigation changes on Duty
or Analysis. Starting another creation intent still asks before discarding a dirty
draft; ordinary group browsing never clears or silently retargets it.

Duty shows one quiet “Непрочитані повідомлення” divider before the first unread
row. Its position stays fixed for the current group/filter/load session while
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
`wdintel-web/tests/e2e/group-feed-unread-state.spec.ts` and
`wdintel-web/tests/e2e/analysis-neo.spec.ts`.
