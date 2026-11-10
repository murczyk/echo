# SIGINT unit hierarchy

Duty, Analysis and the Callsigns sidebar read the hierarchy through
`POST /api/sigint/units/hierarchy`. The endpoint uses two Redis keys:

- `sigint:unit-tree:v1`: the computed groups, unit membership and revision.
- `sigint:unit-tree:v1:dirty`: a boolean, defaulting to false when absent.

A missing, malformed, expired or dirty tree causes the next request to rebuild
the whole hierarchy from non-deleted units, including inactive units. Echelon
fields remain the source of truth; no tree is persisted in PostgreSQL. Virtual
parents, empty echelons and distinct regional paths retain their existing filter
identities.

Rebuilds share a PostgreSQL advisory transaction lock. A dedicated Redis
connection watches both keys before reading the units, then publishes the tree
and clears the marker atomically. Snapshots expire after five minutes; legacy
snapshots without expiry are rebuilt as well. This bounds stale data after lost
notifications, interrupted imports or direct database writes. A concurrent
invalidation aborts publication, and the current request retries with a fresh
database transaction.

Committed application writes invalidate the cache when publishing
`ETUnitChanged`, even with no connected sessions. Unit, Etalon and ORBIT import
and maintenance commands invalidate after completion, including failures that
may have committed part of a batch; dry-run commands do not invalidate.
Maintenance that changes units directly in SQL should also invalidate this cache
to make the changes available immediately.

Clients can request `unit_ids` and `selection_values`. A scoped response contains
only those units, the selected units and their ancestor paths; omitted
`unit_ids` retains the complete-tree response for older clients. The server
resolves selected unit IDs, names and virtual parents against the complete
cached tree, returning descendant IDs in `selections` without transferring
unrelated unit records. Inactive descendants and distinct regional paths remain
part of parent selections. An unknown virtual parent resolves to no IDs rather
than broadening a filter.

Analysis and Duty request only their selected/denied branches. Their unit-count
APIs already return parent options and counts. The Callsigns sidebar requests
paths only for units present in its statistics. Empty scopes need no request.
Scoped revisions hash the returned contents, including resolved selections;
clients send their known revision and unchanged responses return JSON `null`.

Mounted consumers share completed and in-flight requests by scope. Focus,
visibility recovery, network recovery and timers do not reload the hierarchy.
`ETUnitChanged` is delivered through the existing event stream, invalidates the
client catalog and refreshes mounted consumers; an explicit Analysis reload
also invalidates it. Failures are shown once and wait for a scope change or
explicit invalidation before retrying. Hierarchy requests time out after thirty
seconds. The server snapshot expiry still bounds stale cache contents on the
next requested read after a lost notification or direct database write.

Analysis and its thread view share a per-page unit lookup cache, fetching only
newly referenced IDs and caching absent IDs as well. Unit changes and explicit
reloads invalidate it. Responses started before invalidation cannot restore
stale records. Reference loading uses those IDs instead of the complete active
unit catalog.

Regression coverage:
`wdintel-rs/src/sigint/unit/hierarchy/tests.rs`,
`wdintel-web/src/ts/react/routes/shared/__tests__/use-unit-hierarchy-catalog.spec.tsx`,
`wdintel-web/src/ts/react/services/__tests__/unit-lookup-cache.spec.ts`.

## Inbox unit labels

Inbox responses keep the stored parser/editor input in `unit`. Cards use
`unit_display` for current names from non-deleted parsed and network-derived
unit links, including inactive units. Names are distinct and ordered by unit ID;
`unit_ids` retains every distinct ID even when names match. Without live links,
`unit_display` is null and cards fall back to `unit`. Older payloads without the
display field use the same fallback.

Edits and direct-submit copies use `unit`, so displaying inferred network units
does not promote them into parsed links or invalidate an explicit selection.
Reconciliation continues to use stored input and selected IDs; display names are
read from the current catalog on each inbox hydration. Renames and merges need
no stored-name backfill, schema migration, or analytics resnapshot for display.
