# Group visibility refresh query plans

Read-only measurements on echo-pivnich, 2026-11-05. All historical reads used
`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)` in a read-only session with
a 30-second statement timeout. No group writes or trigger executions were
performed during these checks.

The deployed synchronous function expanded a group's complete message history
inside the triggering statement. The API process uses a 20-second
`statement_timeout`. `signal_message_group` had approximately 36 million rows
and `sigint_inbox_item` approximately 21 million rows, and one integration was
publishing.

| Group messages (`signal_message_group` rows) | Result on 2026-11-02 and 2026-11-03 |
| --- | --- |
| 144 to 593,632 | Six groups added successfully |
| 1,458,381 | Archive failed with `57014` |
| 3,745,680 | Add to direction failed with `57014` |

The largest group's plan had to walk all 3.7 million index entries and merge
them with the inbox primary key before inserting any outbox row. Per-row foreign
key checks then ran on every insert; one logged timeout landed in such a check.

The replacement pages the largest group by `signal_message_id`:

| Read | Index and index condition | Rows returned | Buffers | Execution time |
| --- | --- | --- | --- | --- |
| One group, first page | `signal_message_group_group_master_key_signal_message_id_idx`; `group_master_key = $key AND signal_message_id > 0` | 500 | 392 hit | 0.307 ms |
| One group, mid history | same index; `group_master_key = $key AND signal_message_id > $cursor` | 500 | 3 hit, 12 read | 0.599 ms |
| All groups, mid history | `signal_message_group_signal_message_id_group_master_key_idx`; `signal_message_id > $cursor AND group_master_key IS NOT NULL` | 500 | 5 hit, 12 read | 1.564 ms |
| Resolve a page to inbox items | `sigint_inbox_item_pkey`; `id = ANY($page)` | 500 | 158 hit, 25 read | 1.562 ms |

Each plan is an index-only scan with zero heap fetches, using streaming `Unique`
over the ordered index, and stops at its page limit. A group row count overstates
its distinct messages: pages read 2 to 3 index entries per message. The page
keeps `sigint_inbox_item` out of the seek so that a long run of messages without
inbox items cannot make one page scan the rest of the group.

These timings cover historical selection, rather than outbox insertion or
publication latency. Expansion commits at most 500 events per transaction. Queue
selection is supported by
`api_integration_iggy_group_refresh_ready_idx (next_attempt_at, id)`, matching
the [unit refresh queue](3858-unit-refresh.md).
