# Personal inbox mentions

Marking a message important can optionally create a personal inbox mention for
each currently active user with effective access to the selected source group.
The actor is excluded. Access is evaluated again when a recipient opens the
inbox, so revoked access hides the notification and removes it from the unread
count.

Events and receipts are operational PostgreSQL data and are excluded from
analytics replication. The migration creates `notification_event` and
`notification_receipt`, plus durable importance-operation records; apply it
before deploying the UI. Dialog submissions carry an operation identifier, so
retries return the current aggregate importance state without recreating a
personal mark or mention. Notifications are not backfilled, and removing an
importance mark never removes prior receipts.

Apply the standard migration runner during deployment. The follow-up repair
migration safely creates a missing `notification_read_boundary_completed`
table and its cleanup index on installations that recorded an early inbox
migration; it neither removes data nor rewrites migration history.

Inbox reads are per recipient. “Mark all as read” uses the panel snapshot
boundary, leaving subsequently created mentions unread. Refreshes reuse the
open panel’s boundary rather than copying the unread set again. Each open
panel has its own boundary, so concurrent panels do not replace one another;
boundaries expire after 15 minutes and are removed after use. At most eight
live panel boundaries are retained for a recipient.

After a completed mark-all request, the server retains a short-lived completion
record for that boundary so a retry returns the original result without reading
newer mentions. Expired, trimmed, or otherwise unavailable boundaries return a
recoverable outcome instead; the panel explains that the inbox changed and
refreshes without applying mark-all to a replacement snapshot.

When the panel refreshes, it sends a bounded rotating batch of loaded receipt
IDs for reconciliation against current access and message state. Over repeated
refreshes this covers retained paginated history without discarding older
items merely because they are absent from the first page.
