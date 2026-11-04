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

Revisions are hashes of the hierarchy contents, so reconciliation keeps the
revision when the structure and names are unchanged. Clients send their known
revision; an unchanged hierarchy returns JSON `null`. Mounted consumers check
every minute while visible and on focus, network recovery or visibility recovery.
Refreshes arriving during a request queue a fresh read after it completes.
Hierarchy requests time out after thirty seconds so stalled connections release
the shared request and allow retries.
Message and callsign counts stay separate from the cached structure. Removing
the tree key is sufficient to force reconstruction on the next request.
The Callsigns sidebar keeps statistics rows absent from a snapshot as selectable
root units until reconciliation supplies their hierarchy; search uses the names
and paths displayed by the current snapshot.
