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
