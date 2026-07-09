# Signal Delete Duplicate Recovery Plan

- [ ] Reproduce the flow where a Signal message is posted, deleted, and reposted with the same body/timestamp enough to be treated as a duplicate.
- [ ] Add focused tests around delete-event handling for an original message that has echo-im duplicates.
- [ ] Implement duplicate promotion as a shared helper, but call it from live delete-event handling first.
- [ ] In delete handling, identify duplicates via `echo_inbox_message.duplicate_of = deleted_inbox.id` instead of loose body/timestamp matching.
- [ ] Promote a replacement duplicate only when the deleted message was the active canonical `signal_message`.
- [ ] Prefer the oldest eligible duplicate row that maps to the same datasource group and is not itself deleted in echo-im.
- [ ] Restore the promoted duplicate `signal_message` by setting `deleted=false`.
- [ ] Replace its `duplicate-trace-*` UID with a real generated message UID.
- [ ] Ensure `signal_message_group` points at the promoted duplicate with the real message UID.
- [ ] Create the missing `sigint_inbox_item` for the promoted duplicate through the normal inbox parsing path.
- [ ] Ensure search, metadata, network calculation, tag suggestion, palitra highlight, and inbox fanout are triggered for the promoted inbox item.
- [ ] Do not delete stored media files or media records when handling message-delete events.
- [ ] Preserve or restore media attachment records for the promoted duplicate if it has attachments.
- [ ] Restore text-only duplicates when the body has usable content, logging enough context to audit missing media.
- [ ] Do not restore media-only duplicates if their stored attachments are missing.
- [ ] Copy comments, bookmarks, and `sigint_important` marks from the deleted original to the promoted duplicate.
- [ ] Do not copy derived/index rows unless the normal promoted inbox parsing path requires them.
- [ ] Resolve or update any `echo_missing_message` row that was marked `Duplicate` for the promoted inbox id.
- [ ] Prevent future dedupe against deleted originals by clearing/updating the Redis dedupe key on delete or by making the cached-original branch skip deleted originals.
- [ ] Keep current behavior for private messages, messages without datasource group mapping, and duplicates whose original is still active.
- [ ] Keep recovery/audit behavior unchanged unless tests show deleted-original duplicates can be discovered there without live updates.
- [ ] Run `cargo fmt`.
- [ ] Run focused Rust tests for messenger delete/dedupe recovery.
- [ ] Run `cargo check` if the touched code compiles beyond the focused tests.

## QnA

No pending questions.
