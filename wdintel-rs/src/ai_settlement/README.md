# Settlement alias dictionary

The last tab at `/admin/ai/settlements`, **Словник синонімів**, manages
PostgreSQL settlement aliases. **Add New** opens a dialog: search by at least
three characters of the settlement name or alias, select the matching settlement using
its district, region and ID, enter the alias, and save. The saved row appears
in the table. Row actions allow editing and deletion with confirmation.
**Завантажити ще** loads the next batch when more rows are available.

`settlement_alias` contains a UUIDv7 `id`, a `settlement_id` foreign key to
`settlement.id`, and non-empty `text`. Aliases retain their spelling; whitespace
is normalized on save. Case-insensitive duplicates for the same settlement
are rejected. Different settlements may share an alias. Deleting a settlement
cascades to its aliases. Admin-only endpoints under
`/api/admin/ai-settlements/aliases/` list, search, save and delete records.

Search and resolution use the shared [`settlement` module](../settlement/README.md).
Exact database names and aliases resolve to their referenced settlement IDs
within the configured settlement catalog. JSON dictionary matching remains the
fallback. This does not change text extraction, prompts or existing message
links; retry unresolved messages explicitly when needed.

Apply `m20261010_085100_settlement_alias` and
`m20261010_094039_settlement_alias_lookup_indexes` before running the updated backend.
The table is excluded from analytics replication; normal deployment synchronizes
the packaged exclusions before migrations. Rollback drops the alias table and
its records, so export aliases before reverting this migration if they must
be retained.

## Worker group restrictions

Successful AI worker results replace the message's parsed locations and reconcile
their settlement links. An empty result clears the locations and links. Failed
requests and stale results leave the existing locations unchanged.

The **Воркер** tab at `/admin/ai/settlements` includes **Групи для обробки**.
Select active, non-deleted, non-archived Signal groups and choose **Лише** to
process messages belonging to any selected group, or **Окрім** to exclude
messages belonging to any selected group, including messages shared with other
groups. An empty selection means no restrictions in either mode.

**Зберегти** persists the configuration and sends a transactional PostgreSQL
notification to restart processing across backend and worker processes. An
in-flight request is cancelled; its job remains pending and stale results cannot
be saved. Existing excluded jobs remain pending, while new excluded messages
are not queued. Changing the restriction can make pending jobs eligible again;
messages skipped before enqueueing require explicit reprocessing.

Apply `m20261010_110158_ai_settlement_worker_groups` before updating the backend.
The nullable settings columns default to unrestricted processing in application
code and are excluded from analytics replication. Rollback removes the saved
restriction. Archived or deleted selections are retained until explicitly
removed, so an unavailable group never silently turns **Лише** into unrestricted
processing; saving requires replacing or removing unavailable selections.

Behavior coverage: `wdintel-rs/src/ai_settlement/worker_group_tests.rs` and
`wdintel-web/tests/e2e/settlement-worker-groups.spec.ts`.
