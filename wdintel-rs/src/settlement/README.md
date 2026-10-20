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

## Joint inbox resolution

For each inbox item, battle-line resolution combines candidates that pass the
existing catalog, AOR and side-specific distance checks. A single candidate-bearing
name without resolved context keeps the existing independent behavior. Names
without eligible candidates remain undefined without blocking the other names.
The worker preserves processed rows and uses already linked settlements with
valid coordinates as fixed context. Explicit relinking oneoffs recompute all
names together; batched requests keep each item's combinations separate.

Candidate groups enter in ascending candidate-count order, then normalized name
and original row order. The first two groups form all possible pairs; subsequent
groups extend the best five combinations. Every pair in a combination must be
strictly less than 50,000 meters apart, measured with PostGIS geography. Rank by
the sum of all pairwise distances, then total distance to the battle line, then
canonical settlement IDs in original row order. Select the first complete
combination even when scores tie. Different aliases may select the same ID.
If no complete combination survives, pending names become undefined together;
incomplete combinations are never persisted.

This width-five beam search is approximate and order-dependent: pruning can
discard a combination needed by a later name. Width, maximum distance and
distance-query batch size are constants in `config.rs`. Distance queries use
bounded coordinate arrays without scanning settlement tables. Per-name caches
hold independent candidate drafts; joint choices are computed separately for
each item. Existing historical undefined rows are not automatically requeued.

Joint-resolution coverage: `wdintel-rs/src/battle_line/settlement_clusters.rs`,
`wdintel-rs/src/battle_line/mod.rs`, and
`wdintel-rs/src/battle_line/settlement_queue.rs`.

Regression coverage: `wdintel-rs/src/settlement/tests.rs`,
`wdintel-rs/src/ai_settlement/aliases/tests.rs`,
`wdintel-rs/src/battle_line/mod.rs`, and
`wdintel-rs/src/battle_line/settlement_queue.rs`.
