# Chat administration query plans (#3311)

Captured on 2026-08-28 from the dedicated database restored with
`deploy/setup_test_database.sh 3311_chats_work`, after applying all Echo IM and
application migrations. The representative fixture contained 500,000 message
rows for one linked client/account: 250,000 inbox messages and 250,000 outbox
messages/instances, distributed evenly over 100 private chats. Tables were
analyzed before measurement.

Both measurements used:

```sql
SET statement_timeout = '30s';
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON) ...;
```

## Chat list, first 101 rows

- Execution time: 6.226 ms.
- Buffers: 3,030 shared hits; no reads or temporary I/O.
- Returned 100 chat identities.
- Each identity performed bounded ordered index seeks through
  `echo_chat_inbox_private_history_idx` and
  `echo_chat_outbox_instance_private_history_idx` (one latest row per identity),
  followed by primary-key lookup of the outbox body.
- The terminal reply branch used
  `echo_chat_outbox_instance_reply_history_idx` and returned immediately when
  no replies existed.

The initial all-history/window implementation took 4,641.653 ms, touched
1,921,764 shared buffers, and wrote 64,100 temporary blocks on the same fixture.
It was replaced by the bounded per-identity seeks measured above.

## Private history, first 51 rows

- Execution time: 1.250 ms.
- Buffers: 1,320 shared hits and 18 reads; no temporary I/O.
- Inbox and outbox branches each stopped after 51 ordered rows by using the
  matching private-history expression indexes.
- Reply/status/body enrichment used primary-key lookups only after the bounded
  candidate set was selected.

The initial participant-expression query took 96.212 ms, scanned all 500,000
message/instance rows, and spilled 3,012 temporary blocks. Resolving the scoped
sender/recipient IDs first and applying the cursor inside each indexed branch
removed those scans and spills.
