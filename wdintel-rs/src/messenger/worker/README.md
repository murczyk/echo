# Group message ingestion

In `/admin/directions-neo`, assigned and orphan group editors expose
«Отримувати нові повідомлення з месенджера». This stores the nullable
`signal_group.fetch_new_messages` flag, which defaults to `true`; `NULL` also
means enabled. The setting applies to the group across messenger accounts.

When explicitly `false`, the receiver acknowledges new echo_im messages without
queueing them. The queue discards pending non-deletion snapshots for that group
before processing attachments, and automatic recovery advances past its messages
without recording them as missing. Previously scheduled recovery attempts fail
with an explanation while the flag is disabled.

Manual message creation in the web UI and group metadata synchronization
(including renames and deletions) remain available. Messenger message deletion
snapshots also continue through reconciliation. Turning the setting on resumes
consumption of new messages; it does not schedule a historical import.
