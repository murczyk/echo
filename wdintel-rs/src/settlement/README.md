# Shared settlement lookup

`crate::settlement` owns database name/alias search and candidate resolution.
Use `search_by_name` for a bounded, case-insensitive substring search and
`find_by_names` for batched exact lookup. Both search `settlement.name` and
`settlement_alias.text`, return canonical database IDs, normalize apostrophe
variants and trim the query. Substring search treats `%`, `_` and `\` literally.
Each settlement appears once per input, including when several aliases match.
An alias shared by different settlements returns all of those settlements.

`resolve_candidates` restricts exact name/alias matches to coordinates in the
configured default or AOR settlement catalogs, using the existing 2 km coordinate
matching tolerance. Dictionary IDs are not PostgreSQL IDs. When an exact database
match is unavailable within that scope, configured dictionary names and their
coordinate-to-database mapping provide the fallback. Exact renamed database names
therefore resolve to their own database rows; explicit aliases resolve to their
foreign-key targets. Battle-line resolution, background linking and oneoffs all
use this path. Missing coordinates cannot produce a geographic candidate.

`m20261010_094039_settlement_alias_lookup_indexes` adds expression trigram indexes
for the same normalized name and alias expressions used by both lookup modes.
Its rollback restores the original settlement-name index and retains alias data.
Lookup changes do not reprocess historical links or change JSON text extraction
and AI prompts. Alias edits take effect on subsequent database lookups.

Inbox links store `is_undefined = false` after a match and `true` after an
unsuccessful resolution. Deleting a linked canonical settlement clears both
`settlement_id` and `is_undefined`, returning the link to the pending queue.
An explicit unsuccessful resolution keeps `true` when clearing an existing link.

Regression coverage: `wdintel-rs/src/settlement/tests.rs`,
`wdintel-rs/src/ai_settlement/aliases/tests.rs`,
`wdintel-rs/src/battle_line/mod.rs`, and
`wdintel-rs/src/battle_line/settlement_queue.rs`.
